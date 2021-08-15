#!/usr/bin/env node

//
// We want to launch a specific competition and monitor it in PM2
//
const pm2 = require('pm2')

const util = require('util');
//const execFile = util.promisify(require('child_process').execFile);
const execFile = require('child_process').execFile;
const exec = require('child_process').exec;


// Get data from database
const escape = require('sql-template-strings')
const mysql = require('serverless-mysql')();

// Load the current base config file
const dotenv = require('dotenv').config({ path: '.env.local' })
const config = dotenv.parsed;

// Set up background fetching of the competition
async function main() {

	if( process.argv.length < 2 ) {
		console.log( "please specify the database name for the competition on the command line" );
		process.exit(1);
	}

    if (dotenv.error) {
        console.log( "New install: no configuration found, or script not being run in the root directory" );
        process.exit(1);
    }

async function p() {
	const databases = process.argv.slice(2);
	console.log( databases );
	let stop = false;
	let dev = false;
	let fe = false;
    let next = false;
    let restart = false;

	for ( db of databases ) {

		if( db == '--stop' ) {
			stop = true;
			console.log( "stopping" );
			continue;
		}

		if( db == '--dev' ) {
			dev = true;
			console.log( "dev" );
			continue;
		}

		if( db == '--fe' ) {
			fe = true;
			console.log( "front end only, no score fetching process" );
			continue;
		}

		if( db == '--next' ) {
			next = true;
            fe = true;
			console.log( "next only" );
			continue;
		}

		if( db == '--restart' ) {
			next = true;
            fe = true;
            restart = true;
			console.log( "next restart only" );
			continue;
		}


		if( config.MYSQL_DATABASE && config.MYSQL_DATABASE != db ) {
			console.log( "you have a different database in .env.local, if you want to run multiples from same config file you should remove this" );
			process.exit(1);
		}

		// Connect to the database
		mysql.config({
			host: config.MYSQL_HOST,
			database: db,
			user: config.MYSQL_USER,
			password: config.MYSQL_PASSWORD
		});

		// Get the soaring spot keys from database
		let keys = (await mysql.query(escape`
              SELECT *
                FROM scoringsource`))[0];
		
		if( ! keys || ! keys.type ) {
			console.log( `no scoringsource configured for ${db}` );
			continue;
		}

		let domain = keys.domain.slice(0, keys.domain.indexOf("."));

		// If the config is forcing localhost then we will use that but fix the ports
		let localhost = false;
		if( config.NEXT_PUBLIC_SITEURL?.match(/localhost/ )) {
			domain = 'localhost';
			localhost = true;
		}

		const environment = {
			'MYSQL_DATABASE': db,
			SHORT_NAME: domain,
			NEXT_PUBLIC_SITEURL: keys.domain,
			NEXT_PUBLIC_WEBSOCKET_HOST: keys.domain,
			API_HOSTNAME: (config.API_HOSTNAME.slice(0,config.API_HOSTNAME.indexOf(":"))||config.API_HOSTNAME) + ':' + (3000+keys.portoffset),
			WEBSOCKET_PORT: 8000+keys.portoffset,
			STATUS_SERVER_PORT: 8100+keys.portoffset
		};

		if( localhost ) {
			console.log( '  configuring for localhost usage based on NEXT_PUBLIC_SITEURL in .env.local' );
			environment.NEXT_PUBLIC_SITEURL = 'localhost:' + (3000+keys.portoffset);
			environment.NEXT_PUBLIC_WEBSOCKET_HOST = 'localhost:' + (8000+keys.portoffset);
		}
			
		console.log( `${domain} [${db}]: www ${3000+keys.portoffset}, api ${environment.API_HOSTNAME}, ws ${environment.WEBSOCKET_PORT}` );

		if( keys.type != '' ) {

			if( stop ) {
				function n() { pm2.delete( domain+"_next", () => process.exit(1) ); }
				function n2() { pm2.delete( domain+"_ogn", n  ); }
				pm2.delete( domain+"_scoring", n2 );
			}
			else {
				console.log( "starting" );
				if( ! fe ) {
					const scoringScript = {'soaringspotkey': 'bin/soaringspot.js',
										   'rst': 'bin/rst.js',
										   'soaringspotscrape': 'bin/ssscrape.js' }[keys.type];

					if( scoringScript ) {
						console.log( `  using scoring script ${scoringScript}` );
						await pm2.start( {
							script: scoringScript,
							name: domain+"_scoring",
							env: environment,
							restart_delay: 100,
							max_restarts: 10,
							autorestart: true,
							log_date_format: "YYYY-MM-DD HH:mm:ss Z",
						});
					} else {
						console.log( `   unknown scoring script type ${keys.type}, not fetching scores` );
					}
				}

				if( ! next ) {
				    await pm2.start( {
					    script: 'bin/ogn.js',
					    name: domain+"_ogn",
					    env: environment,
					    restart_delay: 30000,
					    max_restarts: 1000,
					    autorestart: true,
					    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
				    });
                }
                    
				function startNext() {
                    const args = {
						script: "./node_modules/.bin/next",
						name: domain+"_next",
						args: (dev ? "dev -p " : "start -p ")+(3000+keys.portoffset), 
						env: environment,
						restart_delay: 30000, // 30 seconds
						max_restarts: 30,
						autorestart: true,
                        updateEnv: true,
						log_date_format: "YYYY-MM-DD HH:mm:ss Z",
					};

                    if( restart ) {
					    pm2.restart( domain+"_next", args, () => { console.log( "next restarted" ); process.exit() } );
                    }
                    else {
					    pm2.start( args, () => { console.log( "next started" ); process.exit() } );
                    }
				}

				
				if( ! dev ) {
					nextBuild( environment, startNext );
				}
				else {
					startNext();
				}
			}
		}
	}
}


	pm2.connect(()=>{ console.log("connected to pm2"); p(); });
//	pm2.disconnect();
//	process.exit();
}

async function nextBuild( env, cb ) {
	console.log( "nextBuild" );
	execFile('./node_modules/.bin/next', ['build'], {env: {...process.env,...env}}, (error, stdout, stderr) => {
		if (error) {
			throw error;
		}
		console.log("o:",stdout);
		console.log("e:",stderr);

		cb();
	} );

}


main()
	.then( () => {} );

