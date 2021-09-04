
let tz = 'UTC';

export function setSiteTz(newtz) {
	tz = newtz;
}

export function timeToText( t ) {
	const dt = new Date(t*1000);
	return dt.toLocaleTimeString( 'en-GB', {timeZone: tz, minute: "2-digit"});
}

export function durationToText( elapsed ) {
    var hours = Math.trunc(elapsed/3600);
    var mins = Math.trunc((elapsed/60)%60);
    var secs = (elapsed%60);
    if( mins < 10 ) {
        mins = "0"+mins;
    }
    if( secs < 10 ) {
        secs = "0"+secs;
    }
    return hours + ":" + mins + ":" + secs;
}

