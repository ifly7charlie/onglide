import {
    setTimeout,
} from 'timers/promises';

/**
 * Basic priority queue implementation. If a better priority queue is wanted/needed,
 * this code works with the implementation in google's closure library (https://code.google.com/p/closure-library/).
 * Use goog.require('goog.structs.PriorityQueue'); and new goog.structs.PriorityQueue()
 */
function PriorityQueue () {
    this._nodes = [];

    this.enqueue = function (priority, key) {
        this._nodes.push({key: key, priority: priority });
        this.sort();
    };
    this.dequeue = function () {
        return this._nodes.shift().key;
    };
    this.sort = function () {
        this._nodes.sort(function (a, b) {
            return a.priority - b.priority;
        });
    };
    this.isEmpty = function () {
        return !this._nodes.length;
    };
}

/**
 * Pathfinding starts here
 */
export default function Graph() {
    var INFINITY = 1/0;
    this.vertices = {};
    
    this.addVertex = function(name, edges){
        this.vertices[name] = edges;
    };

    this.addLink = function(src,dest,weight){
        if( ! this.vertices[src] ) {
	    this.vertices[src] = {}
	};
	(this.vertices[src])[dest] = weight;
	    
        if( ! this.vertices[dest] ) {
			this.vertices[dest] = {}
		};
		(this.vertices[dest])[src] = weight;
    };
	
    this.removeLink = function(src,dest){
        this.vertices[src][dest] = undefined;
        this.vertices[dest][src] = undefined;
    };
    this.removeLinks = function(src){
        this.vertices[src] = {};
    };

    this.shortestPath = async function (start, finish) {
		let lastYield = process.hrtime()
		let startTime = lastYield;
		let yields = 0;
		
        var nodes = new PriorityQueue(),
            distances = {},
            previous = {},
            path = [],
            smallest, vertex, neighbor, alt;

        for(vertex in this.vertices) {
            if(vertex == start) {
                distances[vertex] = 0;
                nodes.enqueue(0, vertex);
            }
            else {
                distances[vertex] = INFINITY;
                nodes.enqueue(INFINITY, vertex);
            }

            previous[vertex] = null;
        }

		let maxl2 = 0;
        while(!nodes.isEmpty()) {
            smallest = nodes.dequeue();

			// Make sure we yield regularily
			let check = process.hrtime(lastYield)[1]
			let l1 = 0;
			let l2 = 0;
			if( check > 20*1e6 ) {
				if( check > 30*1e6 ) {
					console.log( 'long gap in yield', (check/100000).toFixed(2), 's' )
				}
				await setTimeout(0);
				lastYield = process.hrtime()
				yields++;
			}
			
            if(smallest == finish) {
                path = [];

                while(previous[smallest]) {
                    path.push(smallest);
                    smallest = previous[smallest];
                }

                break;
            }

            if(!smallest || distances[smallest] === INFINITY){
                continue;
            }

            for(neighbor in this.vertices[smallest]) {
				l2++;
				if( !(l2 % 50) && check > 20*1e6 ) {
					if( check > 30*1e6 ) {
						console.log( 'long gap in yield', (check/100000).toFixed(2), 's' )
					}
					await setTimeout(0);
					lastYield = process.hrtime()
					yields++;
				}
                alt = distances[smallest] + this.vertices[smallest][neighbor];

                if(alt < distances[neighbor]) {
                    distances[neighbor] = alt;
					previous[neighbor] = smallest;
					nodes.enqueue(alt, neighbor);
                };
            }
			if( l2 > maxl2 ) {
				maxl2 = l2;
			}
				
		}

		console.log( `dijkstra ${process.hrtime(startTime)}, yields ${yields}, nodes ${this.vertices.length}, l2 ${maxl2}` );
        return path;
    };
}

/*
var g = new Graph();

g.addVertex('A', {B: 7, C: 8});
g.addVertex('B', {A: 7, F: 2});
g.addVertex('C', {A: 8, F: 6, G: 4});
g.addVertex('D', {F: 8});
g.addVertex('E', {H: 1});
g.addVertex('F', {B: 2, C: 6, D: 8, G: 9, H: 3});
g.addVertex('G', {C: 4, F: 9});
g.addVertex('H', {E: 1, F: 3});

// Log test, with the addition of reversing the path and prepending the first node so it's more readable
console.log("dij:"+(g.shortestPath('A', 'H').concat(['A']).reverse()));
console.log("dij:"+(g.shortestPath('B', 'H').concat(['B']).reverse()));
*/
