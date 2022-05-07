

const NodeCache = require( "node-cache" );
const myCache = new NodeCache( { useClones: false, deleteOnExpire: true, checkperiod: 60 });

function useKVs () {
    return myCache
}

module.exports = useKVs;
exports = module.exports;
exports.useKVs = useKVs;
