import mysql from 'serverless-mysql';
    
export const db = mysql({
	config: {
	    host: process.env.MYSQL_HOST,
	    database: process.env.MYSQL_DATABASE,
	    user: process.env.MYSQL_USER,
	    password: process.env.MYSQL_PASSWORD
	}
    })



export default async function (query)  {
    try {
		const results = await db.query(query)
		await db.end()
		return results
    } catch (error) {
		console.log( error );
		return { error }
    }
}


