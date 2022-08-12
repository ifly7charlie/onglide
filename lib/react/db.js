const mysql = require('serverless-mysql');

const db = mysql({
    config: {
        host: process.env.MYSQL_HOST,
        database: process.env.MYSQL_DATABASE,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        onError: (x) => {
            console.log('mysql errror', x);
        },
        onConnectError: (x) => {
            console.log('mysql connect errror', x);
        },
        onKill: (x) => {
            console.log('mysql killed', x);
        }
    }
});

exports.query = async (query) => {
    try {
        const results = await db.query(query);
        await db.end();
        return results;
    } catch (error) {
        console.log(error);
        return {error};
    }
};

exports.queryRow = async (query) => {
    try {
        const results = await db.query(query);
        await db.end();
        return results?.[0] || {};
    } catch (error) {
        console.log(error);
        return {error};
    }
};

exports.db = db;
