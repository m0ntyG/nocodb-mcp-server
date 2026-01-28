#!/usr/bin/env node
import {McpServer, ResourceTemplate} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {z} from "zod";
import axios, {AxiosInstance, AxiosError} from "axios";
import {fork} from "node:child_process";
import {logger} from "./logger.js";

// Configuration validation schema
const ConfigSchema = z.object({
    NOCODB_URL: z.string().url().min(1, "NOCODB_URL must be a valid URL"),
    NOCODB_BASE_ID: z.string().min(1, "NOCODB_BASE_ID is required"),
    NOCODB_API_TOKEN: z.string().min(1, "NOCODB_API_TOKEN is required"),
});

// Validate and get configuration
function getValidatedConfig() {
    let NOCODB_URL = process.env.NOCODB_URL || process.argv[2];
    let NOCODB_BASE_ID = process.env.NOCODB_BASE_ID || process.argv[3];
    let NOCODB_API_TOKEN = process.env.NOCODB_API_TOKEN || process.argv[4];

    try {
        return ConfigSchema.parse({
            NOCODB_URL,
            NOCODB_BASE_ID,
            NOCODB_API_TOKEN,
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            const messages = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
            throw new Error(`Configuration validation failed: ${messages}`);
        }
        throw error;
    }
}

// Get config but allow it to fail gracefully during module load
let config: { NOCODB_URL: string; NOCODB_BASE_ID: string; NOCODB_API_TOKEN: string; };
try {
    config = getValidatedConfig();
} catch (error) {
    // If validation fails during module load, we'll retry in main()
    config = {
        NOCODB_URL: process.env.NOCODB_URL || '',
        NOCODB_BASE_ID: process.env.NOCODB_BASE_ID || '',
        NOCODB_API_TOKEN: process.env.NOCODB_API_TOKEN || '',
    };
}

let NOCODB_URL = config.NOCODB_URL;
let NOCODB_BASE_ID = config.NOCODB_BASE_ID;
let NOCODB_API_TOKEN = config.NOCODB_API_TOKEN;


const filterRules =
    `
Comparison Operators
Operation Meaning Example
eq  equal (colName,eq,colValue)
neq not equal (colName,neq,colValue)
not not equal (alias of neq)  (colName,not,colValue)
gt  greater than  (colName,gt,colValue)
ge  greater or equal  (colName,ge,colValue)
lt  less than (colName,lt,colValue)
le  less or equal (colName,le,colValue)
is  is  (colName,is,true/false/null)
isnot is not  (colName,isnot,true/false/null)
in  in  (colName,in,val1,val2,val3,val4)
btw between (colName,btw,val1,val2)
nbtw  not between (colName,nbtw,val1,val2)
like  like  (colName,like,%name)
isWithin  is Within (Available in Date and DateTime only) (colName,isWithin,sub_op)
allof includes all of (colName,allof,val1,val2,...)
anyof includes any of (colName,anyof,val1,val2,...)
nallof  does not include all of (includes none or some, but not all of) (colName,nallof,val1,val2,...)
nanyof  does not include any of (includes none of)  (colName,nanyof,val1,val2,...)


Comparison Sub-Operators
The following sub-operators are available in Date and DateTime columns.

Operation Meaning Example
today today (colName,eq,today)
tomorrow  tomorrow  (colName,eq,tomorrow)
yesterday yesterday (colName,eq,yesterday)
oneWeekAgo  one week ago  (colName,eq,oneWeekAgo)
oneWeekFromNow  one week from now (colName,eq,oneWeekFromNow)
oneMonthAgo one month ago (colName,eq,oneMonthAgo)
oneMonthFromNow one month from now  (colName,eq,oneMonthFromNow)
daysAgo number of days ago  (colName,eq,daysAgo,10)
daysFromNow number of days from now (colName,eq,daysFromNow,10)
exactDate exact date  (colName,eq,exactDate,2022-02-02)

For isWithin in Date and DateTime columns, the different set of sub-operators are used.

Operation Meaning Example
pastWeek  the past week (colName,isWithin,pastWeek)
pastMonth the past month  (colName,isWithin,pastMonth)
pastYear  the past year (colName,isWithin,pastYear)
nextWeek  the next week (colName,isWithin,nextWeek)
nextMonth the next month  (colName,isWithin,nextMonth)
nextYear  the next year (colName,isWithin,nextYear)
nextNumberOfDays  the next number of days (colName,isWithin,nextNumberOfDays,10)
pastNumberOfDays  the past number of days (colName,isWithin,pastNumberOfDays,10)
Logical Operators

Operation Example
~or (checkNumber,eq,JM555205)~or((amount, gt, 200)~and(amount, lt, 2000))
~and  (checkNumber,eq,JM555205)~and((amount, gt, 200)~and(amount, lt, 2000))
~not  ~not(checkNumber,eq,JM555205)


For date null rule
(date,isnot,null) -> (date,notblank).
(date,is,null) -> (date,blank).
`

// Retry configuration (can be customized via environment variables)
function parseNonNegativeIntEnv(envValue: string | undefined, defaultValue: number, name: string): number {
    if (!envValue) {
        return defaultValue;
    }
    
    const parsed = parseInt(envValue, 10);
    
    if (!Number.isFinite(parsed) || parsed < 0) {
        logger.warn(
            `Invalid value for ${name} ("${envValue}"). ` +
            `Using default value ${defaultValue}. ` +
            `Expected a non-negative integer.`
        );
        return defaultValue;
    }
    
    return parsed;
}

const MAX_RETRIES = parseNonNegativeIntEnv(process.env.MAX_RETRIES, 3, "MAX_RETRIES");
const RETRY_DELAY = parseNonNegativeIntEnv(process.env.RETRY_DELAY, 1000, "RETRY_DELAY"); // milliseconds
const REQUEST_TIMEOUT = parseNonNegativeIntEnv(process.env.REQUEST_TIMEOUT, 60000, "REQUEST_TIMEOUT"); // milliseconds

// Simple sleep function for retry delays
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Enhanced error formatter
function formatAxiosError(error: AxiosError): string {
    if (error.response) {
        // Server responded with error status
        return `NocoDB API error (${error.response.status}): ${JSON.stringify(error.response.data)}`;
    } else if (error.request) {
        // Request made but no response received
        return `No response from NocoDB server. Check if the URL is correct and the server is running: ${error.message}`;
    } else {
        // Error in request setup
        return `Request setup error: ${error.message}`;
    }
}

// Axios retry wrapper
async function axiosWithRetry<T>(
    requestFn: () => Promise<T>,
    retries = MAX_RETRIES,
    context = "API request"
): Promise<T> {
    let lastError: Error | null = null;
    const startTime = Date.now();
    
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const result = await requestFn();
            const duration = Date.now() - startTime;
            
            if (attempt > 0) {
                logger.info(`${context} succeeded after ${attempt} retries`, { duration, attempts: attempt + 1 });
            } else {
                logger.debug(`${context} succeeded`, { duration });
            }
            
            return result;
        } catch (error) {
            lastError = error as Error;
            
            // Log the error
            logger.debug(`${context} attempt ${attempt + 1} failed`, {
                error: (error as Error).message,
                attempt: attempt + 1,
                maxAttempts: retries + 1
            });
            
            // Don't retry on client errors (4xx)
            if (axios.isAxiosError(error) && error.response?.status && error.response.status >= 400 && error.response.status < 500) {
                logger.error(`${context} failed with client error`, {
                    status: error.response.status,
                    error: formatAxiosError(error)
                });
                throw new Error(formatAxiosError(error));
            }
            
            // If we have retries left, wait and try again
            if (attempt < retries) {
                const delay = RETRY_DELAY * Math.pow(2, attempt); // Exponential backoff
                logger.warn(`${context} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms...`);
                await sleep(delay);
            }
        }
    }
    
    // All retries exhausted
    logger.error(`${context} failed after all retries`, {
        attempts: retries + 1,
        error: lastError?.message
    });
    
    if (axios.isAxiosError(lastError)) {
        throw new Error(formatAxiosError(lastError));
    }
    throw lastError || new Error(`${context} failed after ${retries + 1} attempts`);
}

// Lazy initialization of the nocodbClient
let nocodbClient: AxiosInstance;

function getNocodbClient(): AxiosInstance {
    if (!nocodbClient) {
        if (!NOCODB_URL || !NOCODB_API_TOKEN) {
            throw new Error('NocoDB client not initialized. Missing configuration.');
        }
        nocodbClient = axios.create({
            baseURL: NOCODB_URL.replace(/\/$/, ""),
            headers: {
                "xc-token": NOCODB_API_TOKEN,
                "Content-Type": "application/json",
            },
            timeout: REQUEST_TIMEOUT,
            validateStatus: (status) => status >= 200 && status < 300,
        });
    }
    return nocodbClient;
}

export async function getRecords(tableName: string,
                                 filters?: string,
                                 limit?: number,
                                 offset?: number,
                                 sort?: string,
                                 fields?: string,
) {
    try {
        // Validate table name
        if (!tableName || typeof tableName !== 'string' || tableName.trim() === '') {
            throw new Error('Table name is required and must be a non-empty string');
        }

        const tableId = await getTableId(tableName);

        const paramsArray = [];
        if (filters) {
            paramsArray.push(`where=${encodeURIComponent(filters)}`);
        }
        if (limit !== undefined) {
            if (limit < 0) throw new Error('Limit must be a non-negative number');
            paramsArray.push(`limit=${limit}`);
        }
        if (offset !== undefined) {
            if (offset < 0) throw new Error('Offset must be a non-negative number');
            paramsArray.push(`offset=${offset}`);
        }
        if (sort) {
            paramsArray.push(`sort=${encodeURIComponent(sort)}`);
        }
        if (fields) {
            paramsArray.push(`fields=${encodeURIComponent(fields)}`);
        }

        const queryString = paramsArray.join("&");
        const url = queryString
            ? `/api/v2/tables/${tableId}/records?${queryString}`
            : `/api/v2/tables/${tableId}/records`;
        const response = await axiosWithRetry(
            () => getNocodbClient().get(url),
            MAX_RETRIES,
            `Get records from table '${tableName}'`
        );

        return {
            input: {
                tableName,
                filters,
                limit,
                offset,
                sort,
                fields
            },
            output: response.data
        };
    } catch (error) {
        throw new Error(`Failed to get records from table '${tableName}': ${(error as Error).message}`);
    }
}

export async function postRecords(tableName: string, data: unknown) {
    try {
        if (!tableName || typeof tableName !== 'string' || tableName.trim() === '') {
            throw new Error('Table name is required and must be a non-empty string');
        }
        if (!data) {
            throw new Error('Data is required for creating records');
        }

        const tableId = await getTableId(tableName);
        const response = await axiosWithRetry(
            () => getNocodbClient().post(`/api/v2/tables/${tableId}/records`, data),
            MAX_RETRIES,
            `Create record in table '${tableName}'`
        );

        return {
            output: response.data,
            input: data
        };
    } catch (error) {
        throw new Error(`Failed to create record in table '${tableName}': ${(error as Error).message}`);
    }
}

export async function patchRecords(tableName: string, rowId: number, data: any) {
    try {
        if (!tableName || typeof tableName !== 'string' || tableName.trim() === '') {
            throw new Error('Table name is required and must be a non-empty string');
        }
        if (!rowId || rowId <= 0) {
            throw new Error('Valid row ID is required (positive number)');
        }
        if (!data) {
            throw new Error('Data is required for updating records');
        }

        const tableId = await getTableId(tableName);
        const newData = [{
            ...data,
            "Id": rowId,
        }]

        const response = await axiosWithRetry(
            () => getNocodbClient().patch(`/api/v2/tables/${tableId}/records`, newData),
            MAX_RETRIES,
            `Update record ${rowId} in table '${tableName}'`
        );

        return {
            output: response.data,
            input: data
        };
    } catch (error) {
        throw new Error(`Failed to update record ${rowId} in table '${tableName}': ${(error as Error).message}`);
    }
}

export async function deleteRecords(tableName: string, rowId: number) {
    try {
        if (!tableName || typeof tableName !== 'string' || tableName.trim() === '') {
            throw new Error('Table name is required and must be a non-empty string');
        }
        if (!rowId || rowId <= 0) {
            throw new Error('Valid row ID is required (positive number)');
        }

        const tableId = await getTableId(tableName);
        const data: any = {
            "Id": rowId
        }

        const response = await axiosWithRetry(
            () => getNocodbClient().delete(`/api/v2/tables/${tableId}/records`, {data}),
            MAX_RETRIES,
            `Delete record ${rowId} from table '${tableName}'`
        );

        return response.data;
    } catch (error) {
        throw new Error(`Failed to delete record ${rowId} from table '${tableName}': ${(error as Error).message}`);
    }
}

export const getTableId = async (tableName: string): Promise<string> => {
    try {
        if (!tableName || typeof tableName !== 'string' || tableName.trim() === '') {
            throw new Error('Table name is required and must be a non-empty string');
        }

        const response = await axiosWithRetry(
            () => getNocodbClient().get(`/api/v2/meta/bases/${NOCODB_BASE_ID}/tables`),
            MAX_RETRIES,
            `Get table ID for '${tableName}'`
        );

        const tables = response.data.list || [];
        if (!Array.isArray(tables)) {
            throw new Error('Invalid response format from NocoDB API');
        }

        const table = tables.find((t: any) => t.title === tableName);
        if (!table) {
            const availableTables = tables.map((t: any) => t.title).join(', ');
            throw new Error(`Table '${tableName}' not found. Available tables: ${availableTables || 'none'}`);
        }

        return table.id;
    } catch (error) {
        if ((error as Error).message.includes('Table')) {
            throw error; // Re-throw table not found errors
        }
        throw new Error(`Error retrieving table ID for '${tableName}': ${(error as Error).message}`);
    }
};

export async function getListTables() {
    try {
        const response = await axiosWithRetry(
            () => getNocodbClient().get(`/api/v2/meta/bases/${NOCODB_BASE_ID}/tables`),
            MAX_RETRIES,
            'Get list of tables'
        );

        const tables = response.data.list || [];
        if (!Array.isArray(tables)) {
            throw new Error('Invalid response format from NocoDB API');
        }

        return tables.map((t: any) => t.title);
    } catch (error) {
        throw new Error(`Failed to get list of tables: ${(error as Error).message}`);
    }
}

export async function getTableMetadata(tableName: string) {
    try {
        if (!tableName || typeof tableName !== 'string' || tableName.trim() === '') {
            throw new Error('Table name is required and must be a non-empty string');
        }

        const tableId = await getTableId(tableName);
        const response = await axiosWithRetry(
            () => getNocodbClient().get(`/api/v2/meta/tables/${tableId}`),
            MAX_RETRIES,
            `Get metadata for table '${tableName}'`
        );

        return response.data;
    } catch (error) {
        throw new Error(`Failed to get metadata for table '${tableName}': ${(error as Error).message}`);
    }
}


// column type

// SingleLineText
// Number
// Decimals
// DateTime
// Checkbox
export async function alterTableAddColumn(tableName: string, columnName: string, columnType: string) {
    try {
        if (!tableName || typeof tableName !== 'string' || tableName.trim() === '') {
            throw new Error('Table name is required and must be a non-empty string');
        }
        if (!columnName || typeof columnName !== 'string' || columnName.trim() === '') {
            throw new Error('Column name is required and must be a non-empty string');
        }
        if (!columnType || typeof columnType !== 'string' || columnType.trim() === '') {
            throw new Error('Column type is required and must be a non-empty string');
        }

        const validColumnTypes = ['SingleLineText', 'Number', 'Decimals', 'DateTime', 'Checkbox'];
        if (!validColumnTypes.includes(columnType)) {
            throw new Error(`Invalid column type '${columnType}'. Valid types: ${validColumnTypes.join(', ')}`);
        }

        const tableId = await getTableId(tableName);
        const response = await axiosWithRetry(
            () => getNocodbClient().post(`/api/v2/meta/tables/${tableId}/columns`, {
                title: columnName,
                uidt: columnType,
            }),
            MAX_RETRIES,
            `Add column '${columnName}' to table '${tableName}'`
        );

        return response.data;
    } catch (error) {
        throw new Error(`Failed to add column '${columnName}' to table '${tableName}': ${(error as Error).message}`);
    }
}

export async function alterTableRemoveColumn(columnId: string) {
    try {
        if (!columnId || typeof columnId !== 'string' || columnId.trim() === '') {
            throw new Error('Column ID is required and must be a non-empty string');
        }

        const response = await axiosWithRetry(
            () => getNocodbClient().delete(`/api/v2/meta/columns/${columnId}`),
            MAX_RETRIES,
            `Remove column with ID '${columnId}'`
        );

        return response.data;
    } catch (error) {
        throw new Error(`Failed to remove column with ID '${columnId}': ${(error as Error).message}`);
    }
}

type ColumnType = "SingleLineText" | "Number" | "Checkbox" | "DateTime" | "ID";
type TableColumnType = {
    title: string;
    uidt: ColumnType
}

export async function createTable(tableName: string, data: TableColumnType[]) {
    try {
        if (!tableName || typeof tableName !== 'string' || tableName.trim() === '') {
            throw new Error('Table name is required and must be a non-empty string');
        }
        if (!data || !Array.isArray(data) || data.length === 0) {
            throw new Error('Column data is required and must be a non-empty array');
        }

        // Validate each column
        data.forEach((col, index) => {
            if (!col.title || typeof col.title !== 'string' || col.title.trim() === '') {
                throw new Error(`Column at index ${index} must have a valid title`);
            }
            if (!col.uidt) {
                throw new Error(`Column '${col.title}' must have a valid column type (uidt)`);
            }
        });

        const hasId = data.filter(x => x.title === "Id").length > 0
        if (!hasId) {
            // insert at first
            data.unshift({
                title: "Id",
                uidt: "ID"
            })
        }

        const response = await axiosWithRetry(
            () => getNocodbClient().post(`/api/v2/meta/bases/${NOCODB_BASE_ID}/tables`, {
                title: tableName,
                columns: data.map((value) => ({
                    title: value.title,
                    uidt: value.uidt
                })),
            }),
            MAX_RETRIES,
            `Create table '${tableName}'`
        );

        return response.data;
    } catch (error) {
        throw new Error(`Failed to create table '${tableName}': ${(error as Error).message}`);
    }
}

export async function listLinkedRecords(tableId: string, linkFieldId: string, recordId: string, fields?: string, sort?: string, where?: string, offset?: number, limit?: number) {
    try {
        if (!tableId || typeof tableId !== 'string' || tableId.trim() === '') {
            throw new Error('Table ID is required and must be a non-empty string');
        }
        if (!linkFieldId || typeof linkFieldId !== 'string' || linkFieldId.trim() === '') {
            throw new Error('Link field ID is required and must be a non-empty string');
        }
        if (!recordId || typeof recordId !== 'string' || recordId.trim() === '') {
            throw new Error('Record ID is required and must be a non-empty string');
        }

        const paramsArray = []
        if (fields) {
            paramsArray.push(`fields=${encodeURIComponent(fields)}`);
        }
        if (sort) {
            paramsArray.push(`sort=${encodeURIComponent(sort)}`);
        }
        if (where) {
            paramsArray.push(`where=${encodeURIComponent(where)}`);
        }
        if (offset !== undefined) {
            if (offset < 0) throw new Error('Offset must be a non-negative number');
            paramsArray.push(`offset=${offset}`);
        }
        if (limit !== undefined) {
            if (limit < 0) throw new Error('Limit must be a non-negative number');
            paramsArray.push(`limit=${limit}`);
        }

        const queryString = paramsArray.join("&");
        const url = `/api/v2/tables/${tableId}/links/${linkFieldId}/records/${recordId}${queryString ? `?${queryString}` : ''}`;

        const response = await axiosWithRetry(
            () => getNocodbClient().get(url),
            MAX_RETRIES,
            `List linked records for record '${recordId}'`
        );

        return {
            input: {
                tableId,
                linkFieldId,
                recordId,
                fields,
                sort,
                where,
                offset,
                limit
            },
            output: response.data
        };
    } catch (error) {
        throw new Error(`Failed to list linked records: ${(error as Error).message}`);
    }
}

export async function createLink(tableId: string, linkFieldId: string, recordId: string, linkRecordIds: number[]) {
    try {
        if (!tableId || typeof tableId !== 'string' || tableId.trim() === '') {
            throw new Error('Table ID is required and must be a non-empty string');
        }
        if (!linkFieldId || typeof linkFieldId !== 'string' || linkFieldId.trim() === '') {
            throw new Error('Link field ID is required and must be a non-empty string');
        }
        if (!recordId || typeof recordId !== 'string' || recordId.trim() === '') {
            throw new Error('Record ID is required and must be a non-empty string');
        }
        if (!linkRecordIds || !Array.isArray(linkRecordIds) || linkRecordIds.length === 0) {
            throw new Error('Link record IDs is required and must be a non-empty array');
        }

        const payload = linkRecordIds.map(id => ({ Id: id }));
        const response = await axiosWithRetry(
            () => getNocodbClient().post(`/api/v2/tables/${tableId}/links/${linkFieldId}/records/${recordId}`, payload),
            MAX_RETRIES,
            `Create links for record '${recordId}'`
        );

        return {
            input: {
                tableId,
                linkFieldId,
                recordId,
                linkRecordIds
            },
            output: response.data
        };
    } catch (error) {
        throw new Error(`Failed to create links: ${(error as Error).message}`);
    }
}

export async function deleteLink(tableId: string, linkFieldId: string, recordId: string, linkRecordIds: number[]) {
    try {
        if (!tableId || typeof tableId !== 'string' || tableId.trim() === '') {
            throw new Error('Table ID is required and must be a non-empty string');
        }
        if (!linkFieldId || typeof linkFieldId !== 'string' || linkFieldId.trim() === '') {
            throw new Error('Link field ID is required and must be a non-empty string');
        }
        if (!recordId || typeof recordId !== 'string' || recordId.trim() === '') {
            throw new Error('Record ID is required and must be a non-empty string');
        }
        if (!linkRecordIds || !Array.isArray(linkRecordIds) || linkRecordIds.length === 0) {
            throw new Error('Link record IDs is required and must be a non-empty array');
        }

        const payload = linkRecordIds.map(id => ({ Id: id }));
        const response = await axiosWithRetry(
            () => getNocodbClient().delete(`/api/v2/tables/${tableId}/links/${linkFieldId}/records/${recordId}`, { data: payload }),
            MAX_RETRIES,
            `Delete links for record '${recordId}'`
        );

        return {
            input: {
                tableId,
                linkFieldId,
                recordId,
                linkRecordIds
            },
            output: response.data
        };
    } catch (error) {
        throw new Error(`Failed to delete links: ${(error as Error).message}`);
    }
}


// Create an MCP server
const server = new McpServer({
    name: "nocodb-mcp-server",
    version: "1.0.0"
});

async function main() {
    // Validate configuration before starting the server
    try {
        config = getValidatedConfig();
        NOCODB_URL = config.NOCODB_URL;
        NOCODB_BASE_ID = config.NOCODB_BASE_ID;
        NOCODB_API_TOKEN = config.NOCODB_API_TOKEN;
        
        logger.info('NocoDB MCP Server starting...', {
            url: NOCODB_URL,
            baseId: NOCODB_BASE_ID,
            debugMode: process.env.DEBUG === 'true'
        });
    } catch (error) {
        logger.error('Configuration error', { error: (error as Error).message });
        console.error('\nPlease provide the required environment variables or command line arguments:');
        console.error('  NOCODB_URL=<url> NOCODB_BASE_ID=<id> NOCODB_API_TOKEN=<token> nocodb-mcp-server');
        console.error('  OR');
        console.error('  nocodb-mcp-server <url> <base_id> <token>');
        process.exit(1);
    }

    server.tool("nocodb-get-records",
        "Nocodb - Get Records" +
        `hint:
    1. Get all records from a table (limited to 10):
       retrieve_records(table_name="customers")
       
    3. Filter records with conditions:
       retrieve_records(
           table_name="customers", 
           filters="(age,gt,30)~and(status,eq,active)"
       )
       
    4. Paginate results:
       retrieve_records(table_name="customers", limit=20, offset=40)
       
    5. Sort results:
       retrieve_records(table_name="customers", sort="-created_at")
       
    6. Select specific fields:
       retrieve_records(table_name="customers", fields="id,name,email")
`,
        {
            tableName: z.string(),
            filters: z.string().optional().describe(
                `Example: where=(field1,eq,value1)~and(field2,eq,value2) will filter records where 'field1' is equal to 'value1' AND 'field2' is equal to 'value2'.
You can also use other comparison operators like 'ne' (not equal), 'gt' (greater than), 'lt' (less than), and more, to create complex filtering rules.
` + " " + filterRules),
            limit: z.number().optional(),
            offset: z.number().optional(),
            sort: z.string().optional().describe("Example: sort=field1,-field2 will sort the records first by 'field1' in ascending order and then by 'field2' in descending order."),
            fields: z.string().optional().describe("Example: fields=field1,field2 will include only 'field1' and 'field2' in the API response."),
        },
        async ({tableName, filters, limit, offset, sort, fields}) => {
            const response = await getRecords(tableName, filters, limit, offset, sort, fields);
            return {
                content: [{
                    type: 'text',
                    mimeType: 'application/json',
                    text: JSON.stringify(response),
                }],
            }
        }
    );

    server.tool(
        "nocodb-get-list-tables",
        `Nocodb - Get List Tables
notes: only show result from output to user
`,
        {},
        async () => {
            const response = await getListTables()
            return {
                content: [{
                    type: 'text',
                    mimeType: 'application/json',
                    text: JSON.stringify(response),
                }],
            }
        }
    )

    server.tool(
        "nocodb-post-records",
        "Nocodb - Post Records",
        {
            tableName: z.string().describe("table name"),
            data: z.any()
                .describe(`The data to be inserted into the table. 
[WARNING] The structure of this object should match the columns of the table.
example:
const response = await postRecords("Shinobi", {
        Title: "sasuke"
})`)
        },
        async ({tableName, data}) => {
            const response = await postRecords(tableName, data)
            return {
                content: [{
                    type: 'text',
                    mimeType: 'application/json',
                    text: JSON.stringify(response),
                }],
            }
        }
    );


    server.tool(
        "nocodb-post-records-bulk",
        "Nocodb - Post Records Multiple Records",
        {
            tableName: z.string().describe("table name"),
            uploadItems: z.array(z.object({
                data: z.any()
                    .describe(`The data to be inserted into the table. 
[WARNING] The structure of this object should match the columns of the table.
example:
const response = await postRecords("Shinobi", {
        Title: "sasuke"
})`)
            })).describe("array of data to be inserted into the table")
        },
        async ({tableName, uploadItems}) => {
            const responses: any[] = [];
            for (const item of uploadItems) {
                const data = item.data;
                if (!data) {
                    throw new Error("Data is required");
                }
                const response = await postRecords(tableName, data)
                responses.push(response);
            }

            return {
                content: [{
                    type: 'text',
                    mimeType: 'application/json',
                    text: JSON.stringify(responses),
                }],
            }
        }
    )
    ;


    server.tool("nocodb-patch-records",
        "Nocodb - Patch Records",
        {
            tableName: z.string(),
            rowId: z.number(),
            data: z.any().describe(`The data to be updated in the table.
[WARNING] The structure of this object should match the columns of the table.
[WARNING] Do not use JavaScript-style Object with Stringified Data
example:
const response = await patchRecords("Shinobi", 2, {
            Title: "sasuke-updated"
})`)
        },
        async ({tableName, rowId, data}) => {
            if (typeof data === 'string'){
                try {
                    data = JSON.parse(data);
                } catch (e) {
                    return {
                        content: [{
                            type: 'text',
                            mimeType: 'application/json',
                            text: JSON.stringify({
                                error: "Data must be a valid JSON object or stringified JSON object"
                            }),
                        }],
                    }
                }
            }
            const response = await patchRecords(tableName, rowId, data)
            return {
                content: [{
                    type: 'text',
                    mimeType: 'application/json',
                    text: JSON.stringify(response),
                }],
            }
        }
    );

    server.tool("nocodb-delete-records",
        "Nocodb - Delete Records",
        {tableName: z.string(), rowId: z.number()},
        async ({tableName, rowId}) => {
            const response = await deleteRecords(tableName, rowId)
            return {
                content: [{
                    type: 'text',
                    mimeType: 'application/json',
                    text: JSON.stringify(response),
                }],
            }
        }
    );

    server.tool("nocodb-delete-records-bulk",
        "Nocodb - Delete Records Multiple Records",
        {
            tableName: z.string().describe("table name"),
            deleteRowsId: z.array(z.object({
                rowId: z.number()
            })).describe("array of data to be deleted from the table")
        },
        async ({tableName, deleteRowsId}) => {
            const responses: any[] = [];
            for (const item of deleteRowsId) {
                const rowId = item.rowId;
                if (!rowId) {
                    throw new Error("Data is required");
                }
                const response = await deleteRecords(tableName, rowId)
                responses.push(response);
            }

            return {
                content: [{
                    type: 'text',
                    mimeType: 'application/json',
                    text: JSON.stringify(responses),
                }],
            }
        }
    );

    server.tool("nocodb-get-table-metadata",
        "Nocodb - Get Table Metadata",
        {tableName: z.string()},
        async ({tableName}) => {
            const response = await getTableMetadata(tableName)
            return {
                content: [{
                    type: 'text',
                    mimeType: 'application/json',
                    text: JSON.stringify(response),
                }],
            }
        }
    );

    server.tool("nocodb-alter-table-add-column",
        "Nocodb - Alter Table Add Column",
        {
            tableName: z.string(),
            columnName: z.string(),
            columnType: z.string().describe("SingleLineText, Number, Decimals, DateTime, Checkbox")
        },
        async ({tableName, columnName, columnType}) => {
            const response = await alterTableAddColumn(tableName, columnName, columnType)
            return {
                content: [{
                    type: 'text',
                    mimeType: 'application/json',
                    text: JSON.stringify(response),
                }],
            }
        }
    );

    server.tool("nocodb-alter-table-remove-column",
        "Nocodb - Alter Table Remove Column" +
        " get columnId from getTableMetadata" +
        " notes: remove column by columnId" +
        " example: c7uo2ruwc053a3a" +
        " [WARNING] this action is irreversible" +
        " [RECOMMENDATION] give warning to user",
        {columnId: z.string()},
        async ({columnId}) => {
            const response = await alterTableRemoveColumn(columnId)
            return {
                content: [{
                    type: 'text',
                    mimeType: 'application/json',
                    text: JSON.stringify(response),
                }],
            }
        }
    );

    server.tool("nocodb-create-table",
        "Nocodb - Create Table",
        {
            tableName: z.string(),
            data: z.array(z.object({
                title: z.string(),
                uidt: z.enum(["SingleLineText", "Number", "Checkbox", "DateTime"]).describe("SingleLineText, Number, Checkbox, DateTime")

            }).describe(`The data to be inserted into the table.
[WARNING] The structure of this object should match the columns of the table.
example:
const response = await createTable("Shinobi", [
        {
            title: "Name",
            uidt: "SingleLineText"
        },
        {
            title: "Age",
            uidt: "Number"
        },
        {
            title: "isHokage",
            uidt: "Checkbox"
        },
        {
            title: "Birthday",
            uidt: "DateTime"
        }
    ]
)`))
        },
        async ({tableName, data}) => {
            const response = await createTable(tableName, data)
            return {
                content: [{
                    type: 'text',
                    mimeType: 'application/json',
                    text: JSON.stringify(response),
                }],
            }
        }
    );

    server.tool("nocodb-list-links",
        "Nocodb - List Linked Records" +
        `
Get linked records for a specific Link field and Record ID.

Example usage:
- List all linked records: listLinkedRecords(tableId, linkFieldId, recordId)
- With specific fields: listLinkedRecords(tableId, linkFieldId, recordId, "field1,field2")
- With pagination: listLinkedRecords(tableId, linkFieldId, recordId, undefined, undefined, undefined, 10, 25)
`,
        {
            tableId: z.string().describe("Table Identifier"),
            linkFieldId: z.string().describe("Links Field Identifier corresponding to the relation field Links established between tables"),
            recordId: z.string().describe("Record Identifier corresponding to the record in this table for which linked records are being fetched"),
            fields: z.string().optional().describe("Comma-separated list of fields to include in the response. Example: fields=field1,field2"),
            sort: z.string().optional().describe("Sort fields. Use '-' prefix for descending order. Example: sort=field1,-field2"),
            where: z.string().optional().describe("Filter conditions. Example: where=(field1,eq,value1)~and(field2,eq,value2)"),
            offset: z.number().optional().describe("Number of records to skip. Default: 0"),
            limit: z.number().optional().describe("Maximum number of records to return. Default: all records")
        },
        async ({tableId, linkFieldId, recordId, fields, sort, where, offset, limit}) => {
            const response = await listLinkedRecords(tableId, linkFieldId, recordId, fields, sort, where, offset, limit)
            return {
                content: [{
                    type: 'text',
                    mimeType: 'application/json',
                    text: JSON.stringify(response),
                }],
            }
        }
    );

    server.tool("nocodb-create-link",
        "Nocodb - Create Link Between Records" +
        `
Link records to a specific Link field and Record ID. Existing links will be unaffected.

Example usage:
- Link single record: createLink(tableId, linkFieldId, recordId, [4])
- Link multiple records: createLink(tableId, linkFieldId, recordId, [4, 5, 6])
`,
        {
            tableId: z.string().describe("Table Identifier"),
            linkFieldId: z.string().describe("Links Field Identifier corresponding to the relation field Links established between tables"),
            recordId: z.string().describe("Record Identifier corresponding to the record in this table for which links are being created"),
            linkRecordIds: z.array(z.number()).describe("Array of record IDs from the adjacent table to link to this record")
        },
        async ({tableId, linkFieldId, recordId, linkRecordIds}) => {
            const response = await createLink(tableId, linkFieldId, recordId, linkRecordIds)
            return {
                content: [{
                    type: 'text',
                    mimeType: 'application/json',
                    text: JSON.stringify(response),
                }],
            }
        }
    );

    server.tool("nocodb-delete-link",
        "Nocodb - Delete Link Between Records" +
        `
Unlink records from a specific Link field and Record ID. Duplicated and non-existent record IDs will be ignored.

Example usage:
- Unlink single record: deleteLink(tableId, linkFieldId, recordId, [1])
- Unlink multiple records: deleteLink(tableId, linkFieldId, recordId, [1, 2, 3])
`,
        {
            tableId: z.string().describe("Table Identifier"),
            linkFieldId: z.string().describe("Links Field Identifier corresponding to the relation field Links established between tables"),
            recordId: z.string().describe("Record Identifier corresponding to the record in this table for which links are being removed"),
            linkRecordIds: z.array(z.number()).describe("Array of record IDs from the adjacent table to unlink from this record")
        },
        async ({tableId, linkFieldId, recordId, linkRecordIds}) => {
            const response = await deleteLink(tableId, linkFieldId, recordId, linkRecordIds)
            return {
                content: [{
                    type: 'text',
                    mimeType: 'application/json',
                    text: JSON.stringify(response),
                }],
            }
        }
    );


// Add a dynamic greeting resource
    server.resource(
        "greeting",
        new ResourceTemplate("greeting://{name}", {list: undefined}),
        async (uri, {name}) => ({
            contents: [{
                uri: uri.href,
                text: `Hello, ${name}!`
            }]
        })
    );

    // Start receiving messages on stdin and sending messages on stdout
    logger.info('Starting MCP server transport...');
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('NocoDB MCP Server is running and ready to accept requests');
}


void main().catch((error) => {
    logger.error('Fatal error during server startup', { error: error.message, stack: error.stack });
    process.exit(1);
});

