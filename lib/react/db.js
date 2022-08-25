const mysql = require('serverless-mysql');

const db = mysql({
    config: {
        host: process.env.MYSQL_HOST,
        database: process.env.MYSQL_DATABASE,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD
    },
    onError: (x) => {
        if (x?.code == 'PROTOCOL_CONNECTION_LOST') {
            console.log('mysql connection lost');
        } else {
            console.log('mysql errror', x);
        }
    },
    onConnectError: (x) => {
        console.log('mysql connect errror', x);
    },
    onKill: (x) => {
        console.log('mysql killed xx', x);
    },
    onClose: (x) => {
        console.log('mysql connection closed', x);
    },
    onConnect: (x) => {
        console.log(`mysql connection opened ${x.config.host}:${x.config.port} user: ${x.config.user} state: ${x.state}`);
    },
    maxConnsFreq: 5 * 60 * 1000,
    usedConnsFreq: 1 * 60 * 1000,
    maxRetries: 2,
    zombieMaxTimeout: 1200,
    connUtilization: 0.5
});

console.log('DB init:', process.env.MYSQL_DATABASE, process.env.MYSQL_USER, process.env.MYSQL_HOST);

exports.query = async (query) => {
    let retry = 0;
    let timeout = 300;
    do {
        try {
            const results = await db.query(Object.assign(query, {timeout: timeout}));
            return results;
        } catch (error) {
            if (error?.code == 'PROTOCOL_SEQUENCE_TIMEOUT') {
                console.log(`retry #${retry}: query timeout ${error.timeout}, ${query?.strings[0]?.substring(0, 40)?.trim()}`);
                timeout += 350;
                retry++;
            } else if (error?.code == 'PROTOCOL_CONNECTION_LOST') {
                console.log(`retry #${retry}: connection lost ${query?.strings[0]?.substring(0, 40)?.trim()}`);
                retry++;
            } else if (error?.code == 'ENETUNREACH') {
                console.log(`retry #${retry}: server unreachable ${query?.strings[0]?.substring(0, 40)?.trim()}`, error);
                retry++;
            } else {
                console.log('queryError', error);
                return {error};
            }
        }
    } while (retry < 2);
};

exports.queryRow = async (query) => {
    try {
        const results = await db.query(Object.assign(query, {timeout: 2000}));
        return results?.[0] || {};
    } catch (error) {
        console.log(error);
        return {error};
    }
};

exports.mysqlEnd = async () => {
    return db.end();
};

exports.db = db;
