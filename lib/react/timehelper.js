export function delayToText( t ) {
    if( ! t || t > 7200 ) return '';
    let secs = Math.floor(t)%60;
    let mins = Math.floor(t/60);
    let hours = Math.floor(t/3600);

    if( secs ) {
        secs = `${(secs < 10 && (mins>0||hours>0))?'0':''}${secs}s`;
    } else {
        secs = undefined;
    }
    if( mins ) {
        mins = `${(mins < 10 && hours > 0)?'0':''}${mins}m`;
        if( mins > 30 ) {
            secs = undefined;
        }
    } else {
        mins = undefined;
    }
    if( hours ) {
        hours = `${hours}h`;
        secs = undefined;
    } else {
        hours = undefined;
    }
    return [hours,mins,secs].join(' ');
}

export function formatTime(t,tz) {
	// Figure out what the local language is for international date strings
	const lang = (navigator.languages != undefined) ? navigator.languages[0] :  navigator.language;
	
	// And then produce a string to display it locally
	const dt = new Date(t*1000);
	return [
		dt.toLocaleTimeString( lang, {timeZone: tz, hour: "2-digit", minute: "2-digit"}), dt.toLocaleTimeString( lang, {timeZone: tz, second: "2-digit"})
	];
}
