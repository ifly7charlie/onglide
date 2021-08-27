import next from 'next'

import { useRouter } from 'next/router'

// What do we need to render the bootstrap part of the page
import Container from 'react-bootstrap/Container';
import Row from 'react-bootstrap/Row';
import Col from 'react-bootstrap/Col';
import Collapse from 'react-bootstrap/Collapse';
import Navbar from 'react-bootstrap/Navbar'
import Nav from 'react-bootstrap/Nav'
import NavDropdown from 'react-bootstrap/NavDropdown'
import ButtonGroup from 'react-bootstrap/ButtonGroup'
import ToggleButton from 'react-bootstrap/ToggleButton'
import Button from 'react-bootstrap/Button'


import { useState } from 'react';

// Helpers for loading contest information etc
import { useContest, usePilots, useTask, Spinner, Error } from './loaders.js';
import { Nbsp, Icon } from './htmlhelper.js';

import _find from 'lodash/find';
import _sortby from 'lodash.sortby';
import _clone from 'lodash/clone';
import _map from 'lodash/map';

// Helpers for sorting pilot list
import { updateSortKeys, nextSortOrder, getSortDescription } from './pilot-sorting.js';
import { displayHeight, displayClimb } from './displayunits.js';

function isoCountryCodeToFlagEmoji(country)
{
   return String.fromCodePoint(...[...country].map(c => c.charCodeAt() + 0x1F1A5));
}

// Figure out what image to display for the pilot. If they have an image then display the thumbnail for it,
// if they have a country then overlay that on the corner.
function PilotImage(props) {
//                   {props.country !== ''&& <div className="icountry" style={{backgroundImage: `url(/flags/${props.country}.png)`}}/>}
    if( props.image && props.image !== '' ) {
        return <div className="ih" style={{backgroundImage: `url(/api/${props.class}/image?compno=${props.compno})`}}>
                   {props.country !== ''&& <div className="icountry">{isoCountryCodeToFlagEmoji(props.country)}</div>}
				   
               </div>

    }
    if( props.country !== '' ) {
        return <div className="ihi">{isoCountryCodeToFlagEmoji(props.country)}</div>
    }

    return <div className="ih" style={{backgroundImage: `url(/flags/outline.png)`}}/>
}

function RoundNumber(v) {
    if( typeof v === 'number' ) {
        v = Math.round(v*10)/10;
        if( isNaN(v) ) {
            v = undefined;
        }
    }

    if( v != '' && v != 0.0 && v != undefined && v != '00:00:00' ) {
        return v;
    }
    else {
        return null;
    }
}

function Optional(props) {
    const v = RoundNumber(props.v);
    if( v ) {
        return (<span style={props.style}>{props.b} {v} {props.e}</span>);
    }
    return null;
}
function OptionalDiv(props) {
    const v = RoundNumber(props.v);
    if( v ) {
        return (<div style={props.style}>{props.b} {v} {props.e}</div>);
    }
    return null;
}
function OptionalText(b, iv, e) {
    const v = RoundNumber(iv);
    if( v ) {
        return `${b ? b : ''}${v}${e?e:''}`;
    }
    return '';
}

export function Details({units,pilot,tz,handicapped}) {

	const [viewOptions,setViewOptions] = useState({task:1,hcapped:0});

    if( ! pilot ) {
        return null;
    }

    // Simplify displaying units

    const altitude =  pilot.altitude ? (<span style={{float:'right', paddingTop:'3px'}}>
                                            Altitude {displayHeight(pilot.altitude,units)} (AGL {displayHeight(pilot.agl,units)})
                                        </span>) : null;

    const climb = (pilot.gainXsecond > 0 || pilot.lossXsecond > 0 ) ? (<><span>
                                                                             {pilot.Xperiod}s average
                                                                             <Nbsp/><Icon type="upload"/> {displayHeight(pilot.gainXsecond,units)}
                                                                             <Nbsp/><Icon type="download"/> {displayHeight(pilot.lossXsecond,units)}
                                                                             <Nbsp/><Icon type="circle-blank"/> {displayClimb(pilot.average,units)}
                                                                         </span><br/></>) : null;

    const speed = pilot.hspeed ?
		  `Speeds: ${pilot.hspeed.toFixed(1)} kph hcap, ${pilot.speed.toFixed(1)} kph` : null;
	
	let legs = ( <></> );
	if( pilot.legs ) {

		const firstIncompleteLeg = pilot.lasttp + ((pilot.finish != '00:00:00' || pilot.utcfinish) ? 1 : 0);
		function legIcon(leg) {
			if( pilot.inturnpoint && (firstIncompleteLeg == leg || firstIncompleteLeg == (leg+1))) {
				return <Icon type='spinner'/>
			}
			return (firstIncompleteLeg == leg) 
				? <Icon type='plane'/> : <Icon type='check'/>
		};

		const accessor = viewOptions.hcapped ? (l) => l.handicapped : (l) => l.actual;
				
		legs = <>
				   <ButtonGroup toggle name="taskleg" role="group" aria-label="task or leg" value={viewOptions.task} className={"smallbuttons"}>
					   {['leg', 'task'].map((radio, idx) => (
						   <Button
							   key={idx}
							   variant={idx==viewOptions.task?"primary":"secondary"}
							   value={idx}
							   onClick={(e) => setViewOptions( {...viewOptions, task:idx })}
						   >
							   {radio}
						   </Button>
					   ))}
				   </ButtonGroup>
				   <ButtonGroup toggle name="hcapped" role="group" aria-label="actual or handicapped" value={viewOptions.hcapped} className={"smallbuttons goright"}>
					   {['actuals','handicapped'].map((radio, idx) => (
						   <Button
							   key={radio}
							   variant={idx==viewOptions.hcapped?"primary":"secondary"}
							   value={idx}
							   onClick={(e) => { setViewOptions( {...viewOptions, hcapped:idx });}}
						   >
							   {radio}
						   </Button>
					   ))}
				   </ButtonGroup>
				   
				   <table className="legs">
					   <thead>
						   <tr>
							   <td></td>
							   { _map( pilot.legs, (x) => x.leg > 0 ? <td>Leg {x.leg} {legIcon(x.leg)}</td> : null )}
						   </tr>
					   </thead>
					   <tbody>
						   <tr>
							   <td>Leg Start</td>
							   { _map( pilot.legs, (x) => x.leg > 0 ? <td>{formatTime(x.time,tz)}</td> : null )}
						   </tr>
						   {(! viewOptions.task) ?
							<>
								<tr>
									<td>Leg Start Altitude</td>
									{ _map( pilot.legs, (x) => x.leg > 0 ? <td>{x.agl}</td> : null )}
								</tr>
								<tr>
									<td>Leg Speed</td>
									{ _map( pilot.legs, (x) => x.leg > 0 ? <td>{accessor(x).legspeed}</td> : null )}
								</tr>
								<tr>
									<td>Leg Distance</td>
									{ _map( pilot.legs, (x) => x.leg > 0 ? <td>{accessor(x).distance||''}</td> : null )}
								</tr>
								<tr>
									<td>Leg Remaining</td>
									{ _map( pilot.legs, (x) => x.leg > 0 ? <td>{accessor(x).distancetonext||''}</td> : null )}
								</tr>
							</> : null
						   }
						   {(viewOptions.task) ?
							<>
								<tr>
									<td>Task Speed</td>
									{ _map( pilot.legs, (x) => x.leg > 0 ? <td>{accessor(x).taskspeed||''}</td> : null )}
								</tr>
								<tr>
									<td>Task Distance</td>
									{ _map( pilot.legs, (x) => x.leg > 0 ? <td>{accessor(x).distancedone||''}</td> : null )}
								</tr>
								{(! pilot.utcfinish && (pilot.finish == '00:00:00' || !pilot.finish)) &&
								 <tr>
									 <td>Task Remaining</td>
									 { _map( pilot.legs, (x) => x.leg > 0 ? <td>{accessor(x).remainingdistance||''}</td> : <td/> )}
								 </tr>
								}
							</> : null
						   }
					   </tbody>
				   </table>
			   </>;
	}


	let times = null;
//	if( pilot.start ) {
//		times = OptionalText( 'Start ',pilot.start )
//			+ OptionalText(' +',pilot.duration)
//			+ OptionalText(' Finish ',pilot.finish);
//	}


    // Figure out what to show based on the db status
    let flightDetails = null;

    switch(pilot.dbstatus) {
    case '-':
    case 'G':
        flightDetails = (<div>
                             No start reported yet<br/>
                             {climb}
                         </div>);
        break;

    case 'S':
        flightDetails = (<div>
                             {climb}
							 {times}
                             {legs}
                             <Optional b="Glide Ratio to Finish" v={pilot.grremaining} e=":1"/>
                             <Optional b=", HCap Ratio" v={pilot.hgrremaining} e=":1"/>
                         </div>);
        break;
    case 'F':
        flightDetails = (<div>
							 {times}
                             {speed}<br/>
                             {legs}
                         </div>);
        break;
    case 'H':
        flightDetails = (<div>
							 {times}
                             {speed}<br/>
                             {legs}
                         </div>);
        break;

    case '/':
    case 'D':
        flightDetails = (<div>Did not fly</div>);
        break;

    default:
        flightDetails = (<div>Possible Landout<br/>
                             {climb}
                             {legs}
                         </div>);
        break;
    }

    // Check at render if we are up to date or not, delay calculated in sorting which
	// gets updated regularily
    const uptodate = ( pilot.delay < 45 );

    // Are we in coverage or not, keyed off uptodate
    const ognCoverage = uptodate ?
          (<span><Nbsp/><a href="#" style={{color:'black'}} title="In OGN Flarm coverage"><Icon type="check"/> {Math.round(pilot.delay)}s delay</a></span>) :
          (<span><Nbsp/><a href="#" style={{color:'grey'}} title="No recent points, waiting for glider to return to coverage">
                            {pilot.delay < 3600 ?
                             <><Icon type="spinner" spin={true}/>Last point {delayToText(pilot.delay)} ago</> :
                             <><Icon type="exclamation"/>{pilot.max > 0?<>&gt;2 hours ago</>:<>No tracking yet</>}</>}
                        </a></span>);

    const flag = ( pilot.country !== '' ) ? <div className="details-flag">{isoCountryCodeToFlagEmoji(pilot.country)}</div> : null;

    return (
        <div className="details" style={{paddingTop:'5px'}}>
            {flag}<h6>{pilot.compno}:<b>{pilot.name}</b> {pilot.glidertype.substring(0,15)} <div className={'pull-right'}>{pilot.follow?<Icon type="screenshot"/>:''}</div><br/>
                      <span style={{fontSize:'80%'}}>{ognCoverage}<span>{altitude}</span></span>
                  </h6>
            <hr style={{borderColor:'white', height:'1px', margin:'0'}}/>
            {flightDetails}
        </div>
    );
}


function Sorting(props) {
    return (
        <>
        <span className="sorting">
					<a title="Sort Automatically" href="#" onClick={()=>props.setSort('auto')}><Icon type="star"/></a>
					<a title="Show Speed" href="#" onClick={()=>props.setSort('speed')}><Icon type="trophy"/></a>
                    <a title="Show Height" href="#" onClick={()=>props.setSort('height')}><Icon type="cloud-upload "/>&nbsp;</a>
                    <a title="Show Current Climb Average" href="#" onClick={()=>props.setSort('climb')}><Icon type="upload "/>&nbsp;</a>
                <a title="Show L/D Remaining" href="#" onClick={()=>props.setSort('ld')}><Icon type="fast-forward "/>&nbsp;</a>
                <a title="Show Handicapped Distance Done" href="#" onClick={()=>props.setSort('distance')}><Icon type="signout "/>&nbsp;</a>
                <a title="Show Handicapped Distance Remaining" href="#" onClick={()=>props.setSort('remaining')}><Icon type="signin "/>&nbsp;</a>
                <a title="Cycle through times" href="#" onClick={()=>props.setSort('times')}><Icon type="time "/>&nbsp;</a>
                <Nbsp/>

                <a href="#" className="d-lg-inline d-none" onClick={() => props.toggleVisible()}
                   title={props.visible?"Hide Results":"Show Results"}
                   aria-controls="task-collapse"
                   aria-expanded={props.visible}>
                <Icon type="tasks"/><Icon type="caret-down"/></a>
        </span>
        <div className="d-lg-inline d-none" id="sortdescription"><br/>{props.sortDescription}</div>
        </>
    );
}


// Display the current height of the pilot as a percentage bar, note this is done altitude not AGL
// which is probably wrong
function PilotHeightBar({pilot}) {
    let bcolour = 'grey';
    const thirds = (pilot.max - pilot.min)/3;
    // Adjust the bar on the pilot marker regardless of status
    let top = Math.min(Math.round(30/(pilot.max - pilot.min) * (pilot.altitude - pilot.min)),30);

	// No altitude, or top to bottom difference is small
    if( !pilot.altitude || thirds < 75 ) {
        top = 0;
    }
    else if( pilot.altitude > thirds * 2 + pilot.min) {
        bcolour = 'green';
    }
    else if ( pilot.altitude > thirds + pilot.min) {
        bcolour = 'orange';
    }
    else {
        bcolour = 'red';
    }

	pilot.heightColour = bcolour;

    return (
        <div className="height" style={{marginTop: `${30-top}px`, height: `${top}px`, borderColor: `${bcolour}`}}/>
    )
}

//
// Figure out what status the pilot is in and choose the correct icon
function PilotStatusIcon({pilot}) {
    let icon = 'question';

    switch(pilot.dbstatus) {
    case '-':
    case 'G':
        if( ! pilot.altitude ) {
            icon = 'exclamation';
        }
        else {
            icon='cloud-upload';
        }
        break;

    case 'S':
        if( ! pilot.altitude ) {
            icon = 'question';
        }
        else
        {
            if( pilot.average > 1 ) {
                icon = 'upload';
            }
            else {
                icon='plane';
            }
            if( pilot.heightColour ) {
                icon = icon + ` h${pilot.heightColour}`;
            }
        }
        break;
    case 'F':  icon='trophy'; break;

    case 'H':  icon='home'; break;
    case '/':  icon='trash'; break;
    case 'D':  icon='ban-circle'; break;
    case 'R':  icon='question'; break;

    default:   icon='road'; break;
    }

	// If it's very delayed and we have had a point and
	// we are in the right mode then display a spinner
    if( ! pilot.utcfinish && (pilot.delay > 3600 && (pilot.dbstatus == 'G'|| pilot.dbstatus == 'S') && pilot.altitude )) {
        return (
            <span className="pilotstatus">
                <Icon type="spinner" spin={true}/>
            </span>
        );
    }

    // If it is a finish and it is scored
    if( pilot.datafromscoring == 'Y' && pilot.dbstatus != 'S' ) {
        icon = 'check';
    }

    return (
        <span className="pilotstatus">
            <Icon type={icon} spin={false}/>
        </span>
    );
}


//
// Render the pilot
function Pilot(props) {

    const className = (props.selected)?"small-pic pilot pilothovercapture selected":"small-pic pilot pilothovercapture";

    // Render the normal pilot icon
    return (
        <li className={className} >
            <a href="#" title={props.pilot.compno + ': ' + props.pilot.name } onClick={()=>{props.select()}}>
                <PilotImage image={props.pilot.image} country={props.pilot.country} compno={props.pilot.compno} class={props.pilot.class}/>
                <div>
                    <PilotHeightBar pilot={props.pilot} />

                    <div className='caption'>
                        {props.pilot.compno}
                        <PilotStatusIcon pilot={props.pilot}/>
                    </div>
                    <div>
                        <div className="data">
                            {props.pilot.displayAs}
                        </div>
                        <div className="units">
                            {props.pilot.units}
                        </div>
                    </div>
                </div>
            </a>
        </li>
    );

}

//
// Render the list of pilots
export function PilotList({vc,pilots,selectedPilot,setSelectedCompno,options,now}) {

    // These are the rendering options
    const [ order, setOrder ] = useState( 'auto' );
    const [ visible, setVisible ] = useState( true );

    // ensure they sort keys are correct for each pilot, we don't actually
    // want to change the loaded pilots file, just the order they are presented
    // this can be done with a clone and reoder
    let mutatedPilotList = _clone(pilots);
    updateSortKeys( mutatedPilotList, order, options.units, now );

    // Generate the pilot list, sorted by the correct key
    const pilotList = _sortby(mutatedPilotList,['sortKey']).reverse()
          .map( (pilot) =>
              <Pilot key={pilot.compno} pilot={pilot} selected={selectedPilot?selectedPilot.compno===pilot.compno:null}
                     select={()=>{(selectedPilot&&selectedPilot.compno==pilot.compno)?setSelectedCompno(null):setSelectedCompno(pilot.compno);}}/>
          );

    // Output the whole of the pilots list component
    return (
        <>
            <Sorting setSort={(o)=>{setOrder(nextSortOrder(o,order))}} sortDescription={getSortDescription(order)}
                     visible={visible} toggleVisible={()=>{setVisible(!visible)}}/>

            <Collapse in={visible}>
                <ul className="pilots">
                    {pilotList}
                </ul>
            </Collapse>

        </>
    );
}

function delayToText( t ) {
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

function formatTime(t,tz) {
	// Figure out what the local language is for international date strings
	const lang = (navigator.languages != undefined) ? navigator.languages[0] :  navigator.language;
	
	// And then produce a string to display it locally
	const dt = new Date(t*1000);
	return dt.toLocaleTimeString( lang, {timeZone: tz, hour: "2-digit", minute: "2-digit"});
}
