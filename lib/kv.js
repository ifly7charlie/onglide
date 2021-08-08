

const NodeCache = require( "node-cache" );
const myCache = new NodeCache( { useClones: false, deleteOnExpire: true, checkperiod: 60 });

export function useKVs () {
    return myCache
}
