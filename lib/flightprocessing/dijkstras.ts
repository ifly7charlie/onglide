//
//
// Calculate shortest path between a map of points
//
//

/**
 * Basic priority queue implementation. If a better priority queue is wanted/needed,
 * this code works with the implementation in google's closure library (https://code.google.com/p/closure-library/).
 * Use goog.require('goog.structs.PriorityQueue'); and new goog.structs.PriorityQueue()
 */
function PriorityQueue() {
    this._nodes = [];

    this.enqueue = function (priority, key) {
        this._nodes.push({key: key, priority: priority});
        this.sort();
    };
    this.enqueuequick = function (priority, key) {
        this._nodes.push({key: key, priority: priority});
    };
    this.sort = function () {
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
export default class Graph<VertexType, WeightType extends number> {
    vertices: Map<VertexType, Map<VertexType, WeightType>>;

    constructor() {
        this.vertices = new Map<VertexType, Map<VertexType, WeightType>>();
    }

    clone(existing: Graph<VertexType, WeightType>) {
        existing.vertices.forEach((dests, src) => {
            dests.forEach((weight, dest) => {
                this.addLink(src, dest, weight);
            });
        });
    }

    /*    addVertex(name: VertexType, edges: Map<VertexType, WeightType>) {
        this.vertices.set(name, edges);
    }
*/
    // Unlink everything related to a specific node
    removeVertex(src: VertexType) {
        this.vertices.get(src)?.forEach((_v, dest) => {
            this.vertices.get(dest).delete(src);
        });
        this.vertices.delete(src);
    }

    // Forward and reverse link - only get weight if it's missing
    addLinkIfMissing(src: VertexType, dest: VertexType, weight: () => WeightType) {
        const srcV = this.vertices.get(src);
        if (!srcV) this.vertices.set(src, new Map().set(dest, weight()));
        else srcV.set(dest, weight());

        const destV = this.vertices.get(dest);
        if (!destV) this.vertices.set(dest, new Map().set(src, weight()));
        else destV.set(src, weight());
    }

    // Forward and reverse ling
    addLink(src: VertexType, dest: VertexType, weight: WeightType) {
        const srcV = this.vertices.get(src);
        if (!srcV) this.vertices.set(src, new Map().set(dest, weight));
        else srcV.set(dest, weight);

        const destV = this.vertices.get(dest);
        if (!destV) this.vertices.set(dest, new Map().set(src, weight));
        else destV.set(src, weight);
    }

    removeLink(src: VertexType, dest: VertexType) {
        this.vertices.get(src)?.delete(dest);
        this.vertices.get(dest)?.delete(src);
    }

    dump(logger, decorator) {
        logger('---->');
        for (const [src, dest] of this.vertices) {
            for (const [neighbor, weight] of dest) {
                logger(decorator(src), ' -> ', decorator(neighbor), ' = ', weight);
            }
        }
        logger('<----');
    }

    findPath(start: VertexType, finish: VertexType) {
        let nodes = new PriorityQueue();
        let distances: Map<VertexType, WeightType> = new Map();
        let previous: Map<VertexType, WeightType | null> = new Map();
        let path: VertexType[] = [];
        let smallest;
        let vertex: VertexType;
        let neighbor;
        let alt;
        const INFINITY: WeightType = (1 / 0) as WeightType;

        //        console.log('shortest path from ', start, ' to ', finish);

        for (const [vertex] of this.vertices) {
            //            console.log(vertex);
            if (vertex == start) {
                distances.set(vertex, 0 as WeightType);
                nodes.enqueuequick(0, vertex);
            } else {
                distances.set(vertex, INFINITY as WeightType);
                nodes.enqueuequick(INFINITY, vertex);
            }
            previous.set(vertex, null);
        }
        nodes.sort();
        //        console.log('nodes--', JSON.stringify(nodes));

        while (!nodes.isEmpty()) {
            smallest = nodes.dequeue();

            if (smallest == finish) {
                path = [];

                while (previous.get(smallest)) {
                    path.push(smallest);
                    smallest = previous.get(smallest);
                }

                break;
            }

            if (!smallest || distances.get(smallest) === INFINITY) {
                continue;
            }

            for (const [neighbor, weight] of this.vertices.get(smallest)) {
                alt = distances.get(smallest) + weight; //neighbors.get(neighbor); //this.vertices.get(smallest).get(neighbor);

                if (alt < distances.get(neighbor)) {
                    distances.set(neighbor, alt);
                    previous.set(neighbor, smallest);
                    nodes.enqueuequick(alt, neighbor);
                }
            }
            nodes.sort();
        }

        return path.concat(start);
    }
}

/*
  Examples: Note that the type can be anything but comparisons are Object.is() so
  only original pointers not deepclones or new objects
  
interface n {
    t: string;
}
const na = {t: 'a'},
    nb = {t: 'b'},
    nc = {t: 'c'},
    nd = {t: 'd'},
    ne = {t: 'e'},
    nf = {t: 'f'},
    _nf = nf;
const __nd = {t: 'd'};


var g = new Graph<n, number>();

g.addLink(na, nb, 10);
g.addLink(na, nc, 5);
g.addLink(nb, nc, 1);
g.addLink(nc, nd, 5);
g.addLink(ne, nd, 3);
g.addLink(ne, nc, 3);
g.addLink(ne, nf, 1);
g.addLink(nf, na, 9);

// Log test, with the addition of reversing the path and prepending the first node so it's more readable
console.log('dij:', g.shortestPath(na, nd).reverse());

var p = new Graph<n, number>();
p.clone(g);
p.removeLink(na, nc);

// unchanged
console.log('dij a->d:', g.shortestPath(na, nd).reverse());

// different
console.log('dij a->d (cloned):', p.shortestPath(na, nd).reverse());

// Copied objects ok
console.log('dij a->f:', p.shortestPath(na, _nf).reverse());

// This fails, the object is different - remember na concacted as not included
// by default
console.log('dij fail:', p.shortestPath(na, __nd).reverse());
console.log('dij fail:', p.shortestPath(na, {...nd}).reverse());
*/
