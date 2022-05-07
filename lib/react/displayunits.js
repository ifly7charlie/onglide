

function convertClimb(c, units) {
	return [ Math.round( c *(units? 19.43844 : 10))/10, units ? 'kt' : 'm/s'];
}

function convertHeight(c, units) {
	return [ Math.round( c *(units? 3.28084 : 1)), units ? 'ft' : 'm'];
}

function displayClimb(c , units) {
	return convertClimb(c,units).join('');
}

function displayHeight(c , units) {
	return convertHeight(c,units).join('');
}


module.exports = { convertClimb, convertHeight, displayClimb, displayHeight }
