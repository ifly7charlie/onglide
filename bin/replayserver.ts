import {readFileSync} from 'fs';
import {createServer} from 'net';

import {aprsParser, aprsPacket} from 'js-aprs-fap';

import yargs from 'yargs';

async function run() {
    const args = await yargs(process.argv.slice(2)) //
        .option('file', {alias: 'f', type: 'string', required: true, description: 'APRS file to play'})
        .option('adjust', {alias: 'a', type: 'number', default: process.env.REPLAY ? Date.now() / 1000 - parseInt(process.env.REPLAY) : 0, description: 'time adjustment, defaults to now - ENV:REPLAY'})
        .option('speed', {alias: 's', type: 'number', default: 1, description: 'replay speed'})
        .help()
        .alias('help', 'h').argv;

    var array = readFileSync(args.file, 'utf8').toString().split('\n');
    let parser = new aprsParser();

    const server = createServer();
    server.on('error', (err) => {
        // Handle errors here.
        throw err;
    });

    server.listen(14580);
    server.on('connection', (socket) => {
        socket.setEncoding('utf8');

        let index = 0;
        socket.on('data', (d) => {
            const ts = d.toString().match(/ts([0-9]+)/)?.[1];
            if (ts) {
                while (index < array.length) {
                    const msg = array[index];
                    const packet = parser.parseaprs(msg);
                    if (packet && packet.timestamp) {
                        if (packet.timestamp >= parseInt(ts) + args.adjust) {
                            break;
                        }
                    }
                    index++;
                }
                console.log(d, 'skipped to ', index);
            }
        });

        let interval = setInterval(() => {
            let timestamp = 0;
            while (index < array.length) {
                const msg = array[index];
                const packet = parser.parseaprs(msg);
                if (packet) {
                    if (timestamp && packet.timestamp > timestamp) {
                        console.log(index, array[index], timestamp, new Date(timestamp * 1000).toISOString());
                        break;
                    }
                    timestamp = packet.timestamp || 0;
                    console.log(timestamp);
                    socket.write(array[index++] + '\r\n');
                }
            }

            if (index == array.length) {
                socket.destroy();
                clearInterval(interval);
            }
        }, 1000 / args.speed);
        socket.on('close', () => {
            clearInterval(interval);
        });
    });
}

run();
