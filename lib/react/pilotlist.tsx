// What do we need to render the bootstrap part of the page
import Collapse from 'react-bootstrap/Collapse';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {solid, regular} from '@fortawesome/fontawesome-svg-core/import.macro';

import {TZ, Compno, PilotScore, VarioData, ScoreData, TrackData, Epoch, PositionStatus} from '../types';

import {API_ClassName_Pilots_PilotDetail, API_ClassName_Pilots} from '../rest-api-types';

import {Optional, OptionalTime, OptionalDuration, OptionalDurationMM} from './optional';
import {useState} from 'react';

import {FlightLegs} from './flightLegs';
import {Sorting} from './sorting';
import {UseMeasure} from './measure';

// Helpers for loading contest information etc
import {Nbsp, TooltipIcon} from './htmlhelper';
import {delayToText, formatTime} from './timehelper.js';

import {find as _find, filter as _filter, sortBy as _sortby, clone as _clone, map as _map} from 'lodash';

// Helpers for sorting pilot list
import {updateSortKeys, nextSortOrder, getSortDescription, ShortDisplayKeys, SortKey} from './pilot-sorting';
import {displayHeight, displayClimb} from './displayunits';

function isoCountryCodeToFlagEmoji(country) {
    return String.fromCodePoint(...[...country].map((c) => c.charCodeAt() + 0x1f1a5));
}

// Figure out what image to display for the pilot. If they have an image then display the thumbnail for it,
// if they have a country then overlay that on the corner.
function PilotImage(props) {
    if (props.image && props.image == 'Y') {
        return (
            <div className="ih" style={{backgroundImage: `url(/api/${props.class}/image?compno=${props.compno})`}}>
                {props.country !== '' && <div className="icountry">{isoCountryCodeToFlagEmoji(props.country)}</div>}
            </div>
        );
    }
    if (props.image) {
        return (
            <div className="ih" style={{backgroundImage: `url(//www.gravatar.com/avatar/${props.image}?d=robohash)`}}>
                {props.country !== '' && <div className="icountry">{isoCountryCodeToFlagEmoji(props.country)}</div>}
            </div>
        );
    }
    if (props.country !== '') {
        return <div className="ihi">{isoCountryCodeToFlagEmoji(props.country)}</div>;
    }

    return <div className="ih" style={{backgroundImage: `url(/flags/outline.png)`}} />;
}

export function Details({units, pilot, score, vario, tz}: {score: PilotScore | null; vario: VarioData | null; tz: TZ; units: number; pilot: API_ClassName_Pilots_PilotDetail}) {
    if (!pilot) {
        return null;
    }

    // Simplify displaying units
    const altitude = vario?.altitude ? (
        <span style={{float: 'right', paddingTop: '3px'}}>
            Altitude {displayHeight(vario.altitude, units)} (AGL {displayHeight(vario.agl, units)})
        </span>
    ) : null;

    const howMuchClimb = vario ? (vario.average > 0.2 ? solid('circle-arrow-up') : vario.average < -0.2 ? solid('circle-arrow-down') : solid('circle-arrow-right')) : solid('question');
    const climb =
        vario && (vario.gainXsecond > 0 || vario.lossXsecond > 0) ? (
            <>
                <span>
                    {vario.Xperiod}s average
                    <Nbsp />
                    <FontAwesomeIcon icon={solid('arrow-up')} /> {displayHeight(vario.gainXsecond, units)}
                    <Nbsp />
                    <FontAwesomeIcon icon={solid('arrow-down')} /> {displayHeight(vario.lossXsecond, units)}
                    <Nbsp />
                    <FontAwesomeIcon icon={howMuchClimb} /> {displayClimb(vario.average, units)}
                </span>
                <br />
            </>
        ) : null;

    const hasHandicappedResults = score?.handicapped;

    const speed = score ? (
        <>
            {hasHandicappedResults && score.handicapped?.taskSpeed ? <>{score.handicapped.taskSpeed.toFixed(1)} kph hcap/</> : null}
            {score.actual?.taskSpeed?.toFixed(1) || '-'} kph
        </>
    ) : null;

    const distance = score ? (
        <>
            &nbsp;
            {hasHandicappedResults && score.handicapped?.taskDistance ? <>{score.handicapped.taskDistance.toFixed(1)} km hcap/</> : null}
            {score.actual?.taskDistance?.toFixed(1) || '-'} km
        </>
    ) : null;

    let times = null;
    if (score?.utcStart) {
        times = (
            <div>
                {OptionalTime('Start ', score.utcStart as Epoch, tz)} {OptionalDuration(' +', score.taskDuration as Epoch)} {OptionalTime(' Finish ', score.utcFinish as Epoch, tz)}
            </div>
        );
    }

    // Figure out what to show based on the db status
    let flightDetails = null;

    if (!score && !vario?.lat) {
        flightDetails = <div>No tracking yet</div>;
    } else if (!score?.utcStart) {
        if (score?.flightStatus == PositionStatus.Grid) {
            flightDetails = <div>Gridded, waiting to fly</div>;
        } else {
            flightDetails = (
                <div>
                    No start reported yet
                    <br />
                    {climb}
                </div>
            );
        }
    } else if (score?.utcFinish) {
        flightDetails = (
            <div>
                {climb}
                {times}
                {speed}
                <FlightLegs score={score} tz={tz} units={units} />
            </div>
        );
    } else {
        if (score?.flightStatus == PositionStatus.Landed) {
            flightDetails = (
                <div>
                    Landed out
                    <br />
                    {distance}
                    <FlightLegs score={score} tz={tz} units={units} />
                </div>
            );
        } else if (score?.flightStatus == PositionStatus.Home) {
            flightDetails = (
                <div>
                    Landed back
                    <br />
                    {distance}
                    <FlightLegs score={score} tz={tz} units={units} />
                </div>
            );
        } else {
            flightDetails = (
                <div>
                    {climb}
                    {times}
                    {speed}
                    {speed ? ',' : ''}
                    {distance}
                    {score.handicapped?.grRemaining ? <br /> : ', '}
                    <Optional b="Glide ratio to Finish" v={score.actual?.grRemaining} e=":1" />
                    <Optional b=", HCap Ratio" v={score.handicapped?.grRemaining} e=":1" />
                    <FlightLegs score={score} tz={tz} units={units} />
                </div>
            );
        }
    }

    // Check at render if we are up to date or not, delay calculated in sorting which
    // gets updated regularily
    const uptodate = (vario?.delay || Infinity) < 45;

    // Are we in coverage or not, keyed off uptodate
    const ognCoverage = uptodate ? (
        <span>
            <Nbsp />
            <a href="#" style={{color: 'black'}} title="In OGN Flarm coverage" className="tooltipicon">
                <FontAwesomeIcon icon={regular('square-check')} /> {Math.round(vario?.delay)}s delay
            </a>
        </span>
    ) : (
        <span>
            <Nbsp />
            <a href="#" style={{color: 'grey'}} title="No recent points, waiting for glider to return to coverage" className="tooltipicon">
                {(vario?.delay || Infinity) < 3600 ? (
                    <>
                        <FontAwesomeIcon icon={solid('spinner')} spin />
                        &nbsp; Last point {delayToText(vario.delay)} ago
                    </>
                ) : (
                    <>
                        <FontAwesomeIcon icon={solid('triangle-exclamation')} />
                        &nbsp;
                        {(vario?.lat || 0) > 0 ? <>&gt;1 hour ago</> : <>No tracking yet</>}
                    </>
                )}
            </a>
        </span>
    );

    const flag = (pilot.country || '') !== '' ? <div className="details-flag">{isoCountryCodeToFlagEmoji(pilot.country)}</div> : null;

    let competitionDelay: any = '';
    if (process.env.NEXT_PUBLIC_COMPETITION_DELAY && (uptodate || vario?.lat)) {
        competitionDelay = (
            <a href="#" title="Tracking is officially delayed for this competition" className="tooltipicon">
                <span style={{color: 'grey'}}>
                    &nbsp;+&nbsp;
                    <FontAwesomeIcon icon={solid('clock-rotate-left')} size="sm" />
                    &nbsp;{OptionalDurationMM('', parseInt(process.env.NEXT_PUBLIC_COMPETITION_DELAY || '0') as Epoch, 'm')}
                </span>
            </a>
        );
    }

    return (
        <div className="details" style={{paddingTop: '5px'}}>
            {flag}
            <h6>
                {pilot.compno}:<b>{pilot.name}</b> {pilot.gliderType.substring(0, 15)} <div className={'pull-right'}>{false /*track.follow*/ ? <FontAwesomeIcon icon={solid('crosshairs')} /> : ''}</div>
                <br />
                <span style={{fontSize: '80%'}}>
                    {ognCoverage}
                    {competitionDelay}
                    <span>{altitude}</span>
                </span>
            </h6>
            <hr style={{borderColor: 'white', height: '1px', margin: '0'}} />
            {flightDetails}
        </div>
    );
}

//<!--                <a title="Show Wind Shading" href="#" onClick={() => props.setOptions('windshade')}>
//                  <Icon type="magic" /> -->
//            </a>

// Display the current height of the pilot as a percentage bar, note this is done altitude not AGL
// which is probably wrong
function PilotHeightBar({pilot}) {
    let bcolour = 'grey';
    const thirds = (pilot.max - pilot.min) / 3;
    // Adjust the bar on the pilot marker regardless of status
    let top = Math.min(Math.round((30 / (pilot.max - pilot.min)) * (pilot.altitude - pilot.min)), 30);

    // No altitude, or top to bottom difference is small
    if (!pilot.altitude || thirds < 75) {
        top = 0;
    } else if (pilot.altitude > thirds * 2 + pilot.min) {
        bcolour = 'green';
    } else if (pilot.altitude > thirds + pilot.min) {
        bcolour = 'orange';
    } else {
        bcolour = 'red';
    }

    pilot.heightColour = bcolour;

    return <div className="height" style={{marginTop: `${30 - top}px`, height: `${top}px`, borderColor: `${bcolour}`}} />;
}

//
// Figure out what status the pilot is in and choose the correct icon
function PilotStatusIcon({display}: {display: ShortDisplayKeys}) {
    // If it's very delayed and we have had a point and
    // we are in the right mode then display a spinner
    if (display.icon == 'nosignal') {
        return (
            <span className="pilotstatus">
                <FontAwesomeIcon icon={solid('spinner')} spin={true} />
            </span>
        );
    }

    return (
        <span className="pilotstatus">
            <FontAwesomeIcon icon={display.icon} spin={false} />
        </span>
    );
}

//
// Render the pilot
function Pilot({pilot, display, selected, select}: {pilot: API_ClassName_Pilots_PilotDetail; display: ShortDisplayKeys; selected: boolean; select: Function}) {
    const className = selected ? 'small-pic pilot pilothovercapture selected' : 'small-pic pilot pilothovercapture';

    // Render the normal pilot icon
    return (
        <li className={className} id={pilot.compno}>
            <a
                href="#"
                title={pilot.compno + ': ' + pilot.name}
                onClick={() => {
                    select();
                }}
            >
                <PilotImage image={pilot.image} country={pilot.country} compno={pilot.compno} class={pilot.class} />
                <div>
                    <PilotHeightBar pilot={pilot} />

                    <div className="caption">
                        {pilot.compno}
                        <PilotStatusIcon display={display} />
                    </div>
                    <div>
                        <div className="data">{display.displayAs}</div>
                        <div className="units">{display.units}</div>
                    </div>
                </div>
            </a>
        </li>
    );
}

//
// Render the list of pilots
export function PilotList({
    pilots,
    pilotScores,
    trackData,
    selectedPilot,
    setSelectedCompno,
    options,
    handicapped,
    now,
    tz
}: //
{
    pilots: API_ClassName_Pilots;
    pilotScores: ScoreData;
    trackData: TrackData;
    selectedPilot: Compno;
    setSelectedCompno: Function;
    options: any;
    handicapped: boolean;
    now: Epoch;
    tz: TZ;
}) {
    // These are the rendering options
    const [order, setOrder] = useState<SortKey>('auto');
    const [visible, setVisible] = useState(true);

    // ensure they sort keys are correct for each pilot, we don't actually
    // want to change the loaded pilots file, just the order they are presented
    // this can be done with a clone and reoder
    let mutatedPilotList = updateSortKeys(pilots, pilotScores, trackData, order as SortKey, options.units, now, tz);

    // Generate the pilot list, sorted by the correct key
    const pilotList = mutatedPilotList.reverse().map((pilot) => {
        return (
            <Pilot
                key={pilot.compno + 'pl'}
                pilot={pilots[pilot.compno]}
                display={pilot}
                selected={selectedPilot === pilot.compno}
                select={() => {
                    selectedPilot === pilot.compno ? setSelectedCompno(null) : setSelectedCompno(pilot.compno);
                }}
            />
        );
    });

    // Output the whole of the pilots list component
    return (
        <>
            <Sorting
                setSort={(o) => {
                    setOrder(nextSortOrder(o, order, handicapped || false));
                }}
                sortOrder={order}
                visible={visible}
                toggleVisible={() => {
                    setVisible(!visible);
                }}
                handicapped={handicapped || false}
            />
            <Collapse in={visible}>
                <ul className="pilots">{pilotList}</ul>
            </Collapse>
        </>
    );
}
