#!/usr/bin/env node


import cluster from 'cluster';
import WebSocket from 'ws';

let wss = {};

for( let a = 0; a < 350; a++ ) {
//	const ws = new WebSocket('ws://localhost:8080/SGP199');
	const ws = new WebSocket('wss://sgp.onglide.com/SGP19B');
	let total = 0;
	
	ws.on('open', function open() {
		console.log( `open ${a}` );
	});
	
	ws.on('message', function incoming(message) {
		console.log( `received ${a}, ${message.length} ${total+=message.length}`);
	});

	wss[a] = ws;
}

	
