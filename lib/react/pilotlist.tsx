// What do we need to render the bootstrap part of the page
import {memo} from 'react';
import Collapse from 'react-bootstrap/Collapse';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {solid, regular} from '@fortawesome/fontawesome-svg-core/import.macro';

import {TZ, Compno, PilotScore, VarioData, ScoreData, TrackData, Epoch, PositionStatus} from '../types';

import {API_ClassName_Pilots_PilotDetail, API_ClassName_Pilots} from '../rest-api-types';

import {Optional, OptionalTime, OptionalDuration, OptionalDurationMM} from './optional';
import {useState, useCallback} from 'react';

import {FlightLegs} from './flightLegs';
import {Sorting} from './sorting';

// Helpers for loading contest information etc
import {delayToText} from './timehelper.js';

import {find as _find, filter as _filter, sortBy as _sortby, clone as _clone, map as _map} from 'lodash';

// Helpers for sorting pilot list
import {updateSortKeys, nextSortOrder, getValidSortOrder, isValidSortOrder, ShortDisplayKeys, SortKey} from './pilot-sorting';
import {displayHeight, convertHeight, convertClimb} from './displayunits';

function isoCountryCodeToFlagEmoji(country: string) {
    return String.fromCodePoint(...[...country].map((c) => c.charCodeAt(0) + 0x1f1a5));
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

    return <div className="ih" style={{backgroundImage: `url(/outline.gif)`}} />;
}

function SummaryComponent({id, title, titleIcon, main, data1, data2, width}: any) {
    return (
        <li id={id} style={{width}}>
            <a href="#" title={title} onClick={() => {}}>
                <div className="caption">
                    {title}
                    {titleIcon || null}
                </div>
                <hr />
                <div>
                    <div className="main-icon">
                        <a href="#" title={main.description} className="tooltipicon">
                            <FontAwesomeIcon icon={main.icon} />
                        </a>
                    </div>
                    <div className="main-text">
                        {main.value}
                        {main.units ? <div className="units">{main.units}</div> : null}
                    </div>
                </div>
                <hr />
                {data1?.value != undefined ? (
                    <div>
                        <div className="data-icon">
                            <a href="#" title={data1.description} className="tooltipicon">
                                <FontAwesomeIcon icon={data1.icon} />
                            </a>
                        </div>
                        <div className="data-text">
                            {data1.value}
                            {data1.units ? <div className="units">{data1.units}</div> : null}
                        </div>
                    </div>
                ) : null}
                {data2?.value !== undefined && data2.value !== null ? (
                    <div>
                        {data2.icon ? (
                            <div className="data-icon">
                                <a href="#" title={data2.description} className="tooltipicon">
                                    <FontAwesomeIcon icon={data2.icon} />
                                </a>
                            </div>
                        ) : null}
                        <div className="data-text">
                            {data2.value}
                            {data2.units ? <div className="units">{data2.units}</div> : null}
                        </div>
                    </div>
                ) : null}
            </a>
        </li>
    );
}

function ClimbComponent({units, vario}: {units: boolean; vario: VarioData}) {
    const howMuchClimb = vario //
        ? vario.average > 0.2
            ? solid('circle-arrow-up')
            : vario.average < -0.2
            ? solid('circle-arrow-down')
            : solid('circle-arrow-right')
        : solid('question');

    const convertedClimb = convertClimb(vario.average, units);

    return (
        <SummaryComponent
            id="climb"
            title="vario" //
            main={{value: !isNaN(convertedClimb[0]) ? convertedClimb[0] : null, icon: howMuchClimb, units: convertedClimb[1]}}
            data1={{value: convertHeight(vario.gainXsecond + vario.lossXsecond, units)[0], units: units ? 'ft' : 'm', icon: solid('cloud-upload')}}
            data2={{value: vario.Xperiod, units: 'sec', icon: solid('hourglass-half')}}
        />
    );
}

const StartComponent = memo(function StartComponent({
    utcStart,
    utcFinish,
    taskTimeRemaining,
    taskDuration,
    tz
}: //
{
    utcStart: Epoch;
    utcFinish: Epoch;
    taskTimeRemaining: Epoch;
    taskDuration: Epoch;
    tz: TZ;
}) {
    const [endTime, description, icon] = utcFinish
        ? [OptionalTime(' ', utcFinish, tz), 'finish time', solid('hourglass-end')] //
        : taskTimeRemaining
        ? [OptionalDuration('', taskTimeRemaining), 'remaining time', solid('history')]
        : ['', 'finish time', null];

    const duration = OptionalDuration('+', taskDuration as Epoch).split(':');

    return (
        <SummaryComponent
            id="times"
            title="times" //
            width="110px"
            main={{value: duration[0] ? duration[0] + ':' + duration[1] : null, units: ':' + duration[2], icon: solid('stopwatch'), description: 'elapsed time'}}
            data1={{value: OptionalTime('', utcStart, tz), icon: solid('hourglass-start'), description: 'start time'}}
            data2={{value: endTime, icon, description: description}}
        />
    );
});

const HandicappedSpeedComponent = memo(function HandicappedSpeedComponent({
    utcFinish,
    handicappedTaskSpeed,
    actualTaskSpeed
}: //
{
    utcFinish: Epoch;
    handicappedTaskSpeed: number;
    actualTaskSpeed: number;
}) {
    return (
        <SummaryComponent
            id="speed"
            title="speed" //
            main={{value: handicappedTaskSpeed, units: 'kph', icon: utcFinish ? solid('trophy') : solid('paper-plane'), description: 'handicapped speed'}}
            data1={{value: actualTaskSpeed, units: 'kph', icon: solid('tachometer-alt'), description: 'actual speed'}}
        />
    );
});
const ActualSpeedComponent = memo(function ActualSpeedComponent({
    utcFinish,
    actualTaskSpeed
}: //
{
    utcFinish: Epoch;
    actualTaskSpeed: number;
}) {
    return (
        <SummaryComponent
            width="100px"
            id="speed"
            title="speed" //
            main={{value: actualTaskSpeed, units: 'kph', icon: utcFinish ? solid('trophy') : solid('paper-plane'), description: 'actual speed'}}
        />
    );
});

function HandicappedDistanceComponent({score}: {score: PilotScore}) {
    return (
        <SummaryComponent
            width="100px"
            id="distance"
            title="distance" //
            main={{value: score.handicapped.taskDistance, units: 'km', icon: score.utcFinish ? solid('trophy') : solid('paper-plane'), description: 'handicapped distance done'}}
            data1={{value: score.actual.taskDistance, units: 'km', icon: solid('right-from-bracket'), description: 'actual distance done'}}
            data2={{value: score.actual.distanceRemaining ?? score.actual.minPossible, units: 'km', icon: solid('right-to-bracket'), description: 'actual minimum distance remaining'}}
        />
    );
}

function ActualDistanceComponent({score}: {score: PilotScore}) {
    return (
        <SummaryComponent
            width="100px"
            id="distance"
            title="distance" //
            main={{value: score.actual.taskDistance, units: 'km', icon: score.utcFinish ? solid('trophy') : solid('paper-plane'), description: 'actual distance done'}}
            data1={{value: score.actual.distanceRemaining ?? score.actual.minPossible, units: 'km', icon: solid('right-to-bracket'), description: 'actual minimum distance remaining'}}
        />
    );
}

function HandicappedGRComponent({score}: {score: PilotScore}) {
    return (
        <SummaryComponent
            width="100px"
            id="gr"
            title="L/D" //
            main={{value: score.handicapped?.grRemaining < 999 ? score.handicapped.grRemaining : null, units: ':1', icon: solid('fast-forward'), description: 'handicapped L/D remaining'}}
            data1={{value: score.actual?.grRemaining < 999 ? score.actual.grRemaining : null, units: ':1', icon: solid('fast-forward'), description: 'actual L/D remaining'}}
        />
    );
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

    const hasHandicappedResults = score?.handicapped;

    const speed = score ? ( //
        hasHandicappedResults ? (
            <HandicappedSpeedComponent utcFinish={score.utcFinish as Epoch} handicappedTaskSpeed={score.handicapped.taskSpeed} actualTaskSpeed={score.actual.taskSpeed} />
        ) : (
            <ActualSpeedComponent utcFinish={score.utcFinish as Epoch} actualTaskSpeed={score.actual.taskSpeed} />
        )
    ) : null;

    const distance = score ? hasHandicappedResults ? <HandicappedDistanceComponent score={score} /> : <ActualDistanceComponent score={score} /> : null;

    let times = null;
    if (score?.utcStart) {
        times = (
            <StartComponent //
                taskDuration={score.taskDuration as Epoch}
                taskTimeRemaining={score.taskTimeRemaining as Epoch}
                utcStart={score.utcStart as Epoch}
                utcFinish={score.utcFinish as Epoch}
                tz={tz}
            />
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
                    <ul className="status">
                        <ClimbComponent vario={vario} units={!!units} />
                    </ul>
                </div>
            );
        }
    } else if (score?.utcFinish) {
        flightDetails = (
            <>
                <ul className="status">
                    {speed}
                    {score?.taskTimeRemaining ? distance : null}
                    {times}
                </ul>
                <FlightLegs score={score} tz={tz} units={units} />
            </>
        );
    } else {
        if (score?.flightStatus == PositionStatus.Landed) {
            flightDetails = (
                <div>
                    Landed out
                    <ul className="status">{distance}</ul>
                    <FlightLegs score={score} tz={tz} units={units} />
                </div>
            );
        } else if (score?.flightStatus == PositionStatus.Home) {
            flightDetails = (
                <div>
                    Landed back
                    <ul className="status">{distance}</ul>
                    <FlightLegs score={score} tz={tz} units={units} />
                </div>
            );
        } else {
            flightDetails = (
                <>
                    <ul className="status">
                        <ClimbComponent vario={vario} units={!!units} />
                        {speed}
                        {distance}
                        {times}
                    </ul>
                    {score.actual?.grRemaining ? <br /> : ', '}
                    <Optional b="Glide ratio to Finish" v={score.actual?.grRemaining < 200 ? score.actual.grRemaining : null} e=":1" />
                    <Optional b=", HCap Ratio" v={score.handicapped?.grRemaining < 200 ? score.handicapped.grRemaining : null} e=":1" />
                    <FlightLegs score={score} tz={tz} units={units} />
                </>
            );
        }
    }

    // Check at render if we are up to date or not, delay calculated in sorting which
    // gets updated regularily
    const uptodate = (vario?.delay || Infinity) < 45;

    // Are we in coverage or not, keyed off uptodate
    const ognCoverage = score?.utcFinish ? (
        'Finished' //
    ) : uptodate ? (
        <span>
            &nbsp;
            <a href="#" style={{color: 'black'}} title="In OGN Flarm coverage" className="tooltipicon">
                <FontAwesomeIcon icon={regular('square-check')} /> {Math.round(vario?.delay)}s delay
            </a>
        </span>
    ) : (
        <span>
            &nbsp;
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

    const flag =
        (pilot.country || '') !== '' ? (
            <div className="details-flag">
                <a href="#" title={new Intl.DisplayNames([], {type: 'region'})?.of(pilot.country) || 'Country Code: ' + pilot.country} className="tooltipicon">
                    {isoCountryCodeToFlagEmoji(pilot.country)}
                </a>
            </div>
        ) : null;

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
            <h6 style={{width: '100%'}}>
                {pilot.compno}:<b>{pilot.name}</b>
                <span style={{float: 'right', paddingRight: '0.5em'}}>{pilot.gliderType.substring(0, 20)}</span>
                <br />
                <span className="largeScreen">{pilot.country ? new Intl.DisplayNames([], {type: 'region'})?.of(pilot.country) : ''}</span>
                <br className="largeScreen" />
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
function PilotStatusIcon({displayIcon}: {displayIcon: string | any}) {
    // If it's very delayed and we have had a point and
    // we are in the right mode then display a spinner
    if (displayIcon == 'nosignal') {
        return (
            <span className="pilotstatus">
                <FontAwesomeIcon icon={solid('spinner')} spin={true} />
            </span>
        );
    }

    return (
        <span className="pilotstatus">
            <FontAwesomeIcon icon={displayIcon} spin={false} />
        </span>
    );
}

//
// Render the pilot
const Pilot = memo(function Pilot({pilot, displayAs, displayUnits, displayIcon, selected, onClick}: {pilot: API_ClassName_Pilots_PilotDetail; displayAs: string; displayUnits: string; displayIcon: any; selected: boolean; onClick: any}) {
    const className = selected ? 'small-pic pilot pilothovercapture selected' : 'small-pic pilot pilothovercapture';

    // Render the normal pilot icon
    return (
        <li className={className} id={pilot.compno}>
            <a href="#" title={pilot.compno + ': ' + pilot.name} onClick={onClick}>
                <PilotImage image={pilot.image} country={pilot.country} compno={pilot.compno} class={pilot.class} />
                <div>
                    <PilotHeightBar pilot={pilot} />

                    <div className="caption">
                        {pilot.compno}
                        <PilotStatusIcon displayIcon={displayIcon} />
                    </div>
                    <div>
                        <div className="data">{displayAs}</div>
                        <div className="units">{displayUnits}</div>
                    </div>
                </div>
            </a>
        </li>
    );
});

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
    const [rawOrder, setOrder] = useState<SortKey>('auto');
    const [visible, setVisible] = useState(true);
    const order = getValidSortOrder(rawOrder, handicapped);

    // ensure they sort keys are correct for each pilot, we don't actually
    // want to change the loaded pilots file, just the order they are presented
    // this can be done with a clone and reoder
    let mutatedPilotList = updateSortKeys(pilots, pilotScores, trackData, order as SortKey, options.units, now, tz);

    // Generate the pilot list, sorted by the correct key
    const pilotList = mutatedPilotList.reverse().map((pilot) => {
        const onClick = useCallback(() => {
            selectedPilot === pilot.compno ? setSelectedCompno(null) : setSelectedCompno(pilot.compno);
        }, [pilot.compno, selectedPilot]);

        return (
            <Pilot //
                key={pilot.compno}
                pilot={pilots[pilot.compno]}
                displayUnits={pilot.units}
                displayIcon={pilot.icon}
                displayAs={pilot.displayAs.toString()}
                selected={selectedPilot === pilot.compno}
                onClick={onClick}
            />
        );
    });

    // Prevent unneeded re-render by using callbacks
    const setSort = useCallback(
        (o) => {
            setOrder(nextSortOrder(o, order, handicapped || false));
        },
        [order, handicapped]
    );
    const toggleVisible = useCallback(() => {
        setVisible(!visible);
    }, [visible]);

    // Output the whole of the pilots list component
    return (
        <>
            <Sorting setSort={setSort} sortOrder={order} visible={visible} toggleVisible={toggleVisible} handicapped={handicapped || false} />
            <Collapse in={visible}>
                <ul className="pilots">{pilotList}</ul>
            </Collapse>
        </>
    );
}
