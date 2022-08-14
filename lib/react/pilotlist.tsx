// What do we need to render the bootstrap part of the page
import Collapse from 'react-bootstrap/Collapse';
import ButtonGroup from 'react-bootstrap/ButtonGroup';

import Button from 'react-bootstrap/Button';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {solid, regular} from '@fortawesome/fontawesome-svg-core/import.macro';

import {TZ, Compno, PilotScore, VarioData, ScoreData, TrackData, Epoch, PositionStatus} from '../types';
import {PilotScoreLeg} from '../protobuf/onglide';
import {API_ClassName_Pilots_PilotDetail, API_ClassName_Pilots} from '../rest-api-types';

import {useState} from 'react';

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

function RoundNumber(v) {
    if (typeof v === 'number') {
        v = Math.round(v * 10) / 10;
        if (isNaN(v)) {
            v = undefined;
        }
    }

    if (v != '' && v != 0.0 && v != undefined && v != '00:00:00' && v != '0') {
        return v;
    } else {
        return null;
    }
}

function Optional(props) {
    const v = RoundNumber(props.v);
    if (v) {
        return (
            <span style={props.style}>
                {props.b} {v} {props.e}
            </span>
        );
    }
    return null;
}
function OptionalDiv(props) {
    const v = RoundNumber(props.v);
    if (v) {
        return (
            <div style={props.style}>
                {props.b} {v} {props.e}
            </div>
        );
    }
    return null;
}
function OptionalText(b, iv, e = null) {
    const v = RoundNumber(iv);
    if (v) {
        return `${b ? b : ''}${v}${e ? e : ''}`;
    }
    return '';
}
function OptionalTime(before: string, t: Epoch | number, tz: TZ, after: string | null = null) {
    if (!t) {
        return '';
    }
    const v = new Date(t * 1000).toLocaleTimeString('uk', {timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit'});
    if (v) {
        return `${before || ''}${v}${after || ''}`;
    }
    return '';
}
function OptionalTimeHHMM(before: string, t: Epoch | number, tz: TZ, after: string | null = null) {
    if (!t) {
        return '';
    }
    const v = new Date(t * 1000).toLocaleTimeString('uk', {timeZone: tz, hour: '2-digit', minute: '2-digit'});
    if (v) {
        return `${before || ''}${v}${after || ''}`;
    }
    return '';
}
function OptionalDuration(before: string, t: Epoch, after: string | null = null) {
    if (!t) {
        return '';
    }
    const v = new Date(t * 1000).toLocaleTimeString('uk', {timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit'});
    if (v) {
        return `${before || ''}${v}${after || ''}`;
    }
    return '';
}
function OptionalDurationHHMM(before: string, t: Epoch, after: string | null = null) {
    if (!t) {
        return '';
    }
    const v = new Date(t * 1000).toLocaleTimeString('uk', {timeZone: 'UTC', hour: '2-digit', minute: '2-digit'});
    if (v) {
        return `${before || ''}${v}${after || ''}`;
    }
    return '';
}
export function OptionalDurationMM(before: string, t: Epoch, after: string | null = null) {
    if (!t) {
        return '';
    }
    const v = new Date(t * 1000).toLocaleTimeString('uk', {timeZone: 'UTC', minute: '2-digit'});
    if (v) {
        return `${before || ''}${v}${after || ''}`;
    }
    return '';
}

export function Details({units, pilot, score, vario, tz}: {score: PilotScore | null; vario: VarioData | null; tz: TZ; units: number; pilot: API_ClassName_Pilots_PilotDetail}) {
    const [viewOptions, setViewOptions] = useState({task: 1, hcapped: 0});

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

    let legs = <></>;
    if (score?.legs) {
        const legIcon = (leg) => {
            if (leg.legno == score.currentLeg) {
                if (score.utcFinish) {
                    return <TooltipIcon icon={solid('trophy')} tooltip="Finished!" />;
                } else if (score.flightStatus == PositionStatus.Landed) {
                    return <TooltipIcon icon={solid('cow')} tooltip="Landout on leg" />;
                } else if (score.flightStatus == PositionStatus.Home) {
                    return <TooltipIcon icon={solid('house')} tooltip="Returned home" />;
                }
                return <TooltipIcon icon={solid('paper-plane')} tooltip="plane still in sector" fade style={{animationDuration: '10s'}} />;
            }
            if (leg.legno > score.currentLeg) {
                return <TooltipIcon icon={solid('hourglass-start')} tooltip="leg not started yet" size="xs" />;
            } else if (leg.estimatedStart || leg.estimatedEnd) {
                return <TooltipIcon icon={solid('signal')} tooltip={`warning: estimated ${leg.estimatedStart ? 'leg start ' : ''}${leg.estimatedEnd ? 'leg end' : ''} due to coverage issue`} />;
            }
            return <TooltipIcon icon={regular('square-check')} tooltip="leg completed" />;
        };

        const accessor = viewOptions.hcapped ? (l: PilotScoreLeg | PilotScore) => l?.handicapped : (l: PilotScoreLeg | PilotScore) => l?.actual;

        const distanceRemaining = (x) => {
            const l = accessor(x);
            if (l && l.maxPossible) {
                return (
                    <td style={{fontSize: 'small'}}>
                        {l.minPossible} to {l.maxPossible}
                        <br />
                        {l.distanceRemaining}
                    </td>
                );
            }
            if (l.distanceRemaining > 0) {
                return <td>{l.distanceRemaining}</td>;
            }
            return null;
        };

        const actualLegs = _filter(score.legs, (f) => f.legno != 0);

        legs = (
            <>
                <br style={{clear: 'both'}} />
                <ButtonGroup key="taskleg" role="group" aria-label="task or leg" className={'smallbuttons goleft'}>
                    {['leg', 'task'].map((radio, idx) => (
                        <Button key={idx} variant={idx == viewOptions.task ? 'primary' : 'secondary'} value={idx} onClick={(e) => setViewOptions({...viewOptions, task: idx})}>
                            {radio}
                        </Button>
                    ))}
                </ButtonGroup>

                {hasHandicappedResults ? (
                    <ButtonGroup key="hcapped" role="group" aria-label="actual or handicapped" className={'smallbuttons goright'}>
                        {['actuals', 'handicapped'].map((radio, idx) => (
                            <Button
                                key={radio}
                                variant={idx == viewOptions.hcapped ? 'primary' : 'secondary'}
                                value={idx}
                                onClick={(e) => {
                                    setViewOptions({...viewOptions, hcapped: idx});
                                }}
                            >
                                {radio}
                            </Button>
                        ))}
                    </ButtonGroup>
                ) : null}

                {viewOptions.task < 2 ? (
                    <table className="legs">
                        <thead>
                            <tr>
                                <td></td>
                                {_map(actualLegs, (x) => (
                                    <td>
                                        Leg {x.legno} {legIcon(x)}
                                    </td>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            <tr style={{fontSize: 'small'}}>
                                <td>Leg Start Altitude</td>
                                {_map(actualLegs, (x) => (x?.alt > 0 ? <td>{displayHeight(x?.alt, units)}</td> : null))}
                            </tr>
                            <tr>
                                <td>Leg Start</td>
                                {_map(actualLegs, (x) => (x.time ? <td>{OptionalTimeHHMM('', x.time as Epoch, tz)}</td> : null))}
                            </tr>
                            <tr style={{fontSize: 'small'}}>
                                <td>Leg Duration</td>
                                {_map(actualLegs, (x) => (x.duration ? <td>{OptionalDurationHHMM('+', x.duration as Epoch)}</td> : null))}
                            </tr>
                            {!viewOptions.task ? (
                                <>
                                    <tr>
                                        <td>Leg Distance</td>
                                        {_map(actualLegs, (x) => (
                                            <td>{accessor(x)?.distance || ''}</td>
                                        ))}
                                    </tr>
                                    <tr>
                                        <td>Leg Speed</td>
                                        {_map(actualLegs, (x) => (
                                            <td>{accessor(x)?.legSpeed}</td>
                                        ))}
                                    </tr>
                                    <tr>
                                        <td>Leg Remaining</td>
                                        {_map(actualLegs, (x) => (x.legno >= score.currentLeg ? distanceRemaining(x) : <td></td>))}
                                    </tr>
                                </>
                            ) : null}
                            {viewOptions.task ? (
                                <>
                                    <tr>
                                        <td>Task Speed</td>
                                        {_map(actualLegs, (x) => (
                                            <td>{accessor(x)?.taskSpeed || ''}</td>
                                        ))}
                                    </tr>
                                    <tr>
                                        <td>Task Distance</td>
                                        {_map(actualLegs, (x) => (
                                            <td>{accessor(x)?.taskDistance || ''}</td>
                                        ))}
                                    </tr>
                                    {!score.utcFinish && (
                                        <tr>
                                            <td>Task Remaining</td>
                                            {_map(score.legs, (x) => (
                                                <td>{x.legno == score.currentLeg - 1 ? distanceRemaining(score) : <td></td>}</td>
                                            ))}
                                        </tr>
                                    )}
                                </>
                            ) : null}
                        </tbody>
                    </table>
                ) : (
                    <>
                        <br style={{clear: 'both'}} />
                        {score.wind?.speed ? (
                            <>
                                Recent Wind {score.wind.speed} kph @ {score.wind.direction}
                            </>
                        ) : null}
                        <br />
                    </>
                )}
            </>
        );
    }

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

    if (!score && !vario) {
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
                {legs}
            </div>
        );
    } else {
        if (score?.flightStatus == PositionStatus.Landed) {
            flightDetails = (
                <div>
                    Landed out
                    <br />
                    {distance}
                </div>
            );
        } else if (score?.flightStatus == PositionStatus.Home) {
            flightDetails = (
                <div>
                    Landed back
                    <br />
                    {distance}
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
                    <Optional b=", Glide ratio to Finish" v={score.actual?.grRemaining} e=":1" />
                    <Optional b=", HCap Ratio" v={score.handicapped?.grRemaining} e=":1" />
                    {legs}
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
                <TooltipIcon icon={regular('square-check')} /> {Math.round(vario?.delay)}s delay
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
                        {(vario?.lat || 0) > 0 ? <>&gt;2 hours ago</> : <>No tracking yet</>}
                    </>
                )}
            </a>
        </span>
    );

    const flag = (pilot.country || '') !== '' ? <div className="details-flag">{isoCountryCodeToFlagEmoji(pilot.country)}</div> : null;

    let competitionDelay: any = '';
    if (process.env.NEXT_PUBLIC_COMPETITION_DELAY) {
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

function Sorting(props) {
    const radarFunction = () => {
        const nextRadar = (props.options.rainRadarAdvance + 1) % 4;
        props.setOptions({...props.options, rainRadarAdvance: nextRadar});
    };

    return (
        <>
            <span className="options">
                <a title="Adjust radar timings" href="#" onClick={radarFunction}>
                    <FontAwesomeIcon icon={solid('umbrella')} />
                </a>
            </span>
            <span className="sorting">
                <a title="Sort Automatically" href="#" onClick={() => props.setSort('auto')}>
                    <FontAwesomeIcon icon={solid('star')} />
                </a>
                <a title="Show Speed" href="#" onClick={() => props.setSort('speed')}>
                    <FontAwesomeIcon icon={solid('trophy')} />
                </a>
                <a title="Show Height" href="#" onClick={() => props.setSort('height')}>
                    <FontAwesomeIcon icon={solid('cloud-upload')} />
                    &nbsp;
                </a>
                <a title="Show Current Climb Average" href="#" onClick={() => props.setSort('climb')}>
                    <FontAwesomeIcon icon={solid('upload')} />
                    &nbsp;
                </a>
                <a title="Show L/D Remaining" href="#" onClick={() => props.setSort('ld')}>
                    <FontAwesomeIcon icon={solid('fast-forward')} />
                    &nbsp;
                </a>
                <a title="Show Distance Done" href="#" onClick={() => props.setSort('distance')}>
                    <FontAwesomeIcon icon={solid('right-from-bracket')} />
                    &nbsp;
                </a>
                <a title="Show Distance Remaining" href="#" onClick={() => props.setSort('remaining')}>
                    <FontAwesomeIcon icon={solid('right-to-bracket')} />
                    &nbsp;
                </a>
                <a title="Cycle through times" href="#" onClick={() => props.setSort('times')}>
                    <FontAwesomeIcon icon={solid('stopwatch')} />
                    &nbsp;
                </a>
                <Nbsp />

                <a href="#" className="d-lg-inline d-none" onClick={() => props.toggleVisible()} title={props.visible ? 'Hide Results' : 'Show Results'} aria-controls="task-collapse" aria-expanded={props.visible}>
                    <FontAwesomeIcon icon={solid('tasks')} />
                    <FontAwesomeIcon icon={props.visible ? solid('caret-up') : solid('caret-down')} />
                </a>
            </span>
            <div className="d-lg-inline d-none" id="sortdescription">
                <br />
                {props.sortDescription}
            </div>
        </>
    );
}

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
    setOptions,
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
    setOptions: Function;
    now: Epoch;
    tz: TZ;
}) {
    // These are the rendering options
    const [order, setOrder] = useState<SortKey>('auto');
    const [visible, setVisible] = useState(true);

    //    if (trackData) {
    //        console.log(trackData);
    //    }

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
                    setOrder(nextSortOrder(o, order));
                }}
                sortDescription={getSortDescription(order)}
                setOptions={(o) => {
                    setOptions({...options, ...o});
                }}
                options={options}
                visible={visible}
                toggleVisible={() => {
                    setVisible(!visible);
                }}
            />

            <Collapse in={visible}>
                <ul className="pilots">{pilotList}</ul>
            </Collapse>
        </>
    );
}
