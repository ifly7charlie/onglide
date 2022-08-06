import next from 'next';

import {useRouter} from 'next/router';

// What do we need to render the bootstrap part of the page
import Container from 'react-bootstrap/Container';
import Row from 'react-bootstrap/Row';
import Col from 'react-bootstrap/Col';
import Collapse from 'react-bootstrap/Collapse';
import Navbar from 'react-bootstrap/Navbar';
import Nav from 'react-bootstrap/Nav';
import NavDropdown from 'react-bootstrap/NavDropdown';
import ButtonGroup from 'react-bootstrap/ButtonGroup';
import ToggleButton from 'react-bootstrap/ToggleButton';
import Button from 'react-bootstrap/Button';

import {TZ, Compno, PilotScore, VarioData, ScoreData, TrackData, Epoch} from '../types';
import {PilotScoreLeg} from '../protobuf/onglide';
import {API_ClassName_Pilots_PilotDetail} from '../rest-api-types';
import {API_ClassName_Pilots} from './react-api-types';

import {useState} from 'react';

// Helpers for loading contest information etc
import {useContest, usePilots, useTask, Spinner, Error} from './loaders';
import {Nbsp, Icon} from './htmlhelper';
import {delayToText, formatTime} from './timehelper.js';

import {find as _find, sortBy as _sortby, clone as _clone, map as _map} from 'lodash';

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
function OptionalTime(before: string, t: Epoch, tz: TZ, after: string | null = null) {
    if (!t) {
        return '';
    }
    const v = new Date(t * 1000).toLocaleTimeString('eu', {timeZone: tz, hour: '2-digit', minute: '2-digit'});
    if (v) {
        return `${before || ''}${v}${after || ''}`;
    }
    return '';
}
function OptionalDuration(before: string, t: Epoch, tz: TZ, after: string | null = null) {
    if (!t) {
        return '';
    }
    const v = new Date(t * 1000).toLocaleTimeString('eu', {timeZone: tz, hour: '2-digit', minute: '2-digit'});
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

    const climb =
        vario && (vario.gainXsecond > 0 || vario.lossXsecond > 0) ? (
            <>
                <span>
                    {vario.Xperiod}s average
                    <Nbsp />
                    <Icon type="upload" /> {displayHeight(vario.gainXsecond, units)}
                    <Nbsp />
                    <Icon type="download" /> {displayHeight(vario.lossXsecond, units)}
                    <Nbsp />
                    <Icon type="circle-blank" /> {displayClimb(vario.average, units)}
                </span>
                <br />
            </>
        ) : null;

    const hasHandicappedResults = score?.handicapped;

    const speed = score ? (
        <>
            Speed:&nbsp;
            {hasHandicappedResults && score.handicapped?.taskSpeed ? <>{score.handicapped.taskSpeed.toFixed(1)} kph hcap</> : null}
            {score.actual?.taskSpeed?.toFixed(1) || '-'} kph
        </>
    ) : null;

    let legs = <></>;
    if (score?.legs) {
        const firstIncompleteLeg = score.currentLeg + (score.utcFinish ? 1 : 0);
        const legIcon = (legno, leg) => {
            if (score.inSector && (firstIncompleteLeg == legno || firstIncompleteLeg == legno + 1)) {
                return <Icon type="spinner" tooltip="plane still in sector" />;
            }
            if (leg.estimatedstart || leg.estimatedend) {
                return <Icon type="signal" tooltip={`warning: estimated ${leg.estimatedstart ? 'leg start ' : ''}${leg.estimatedend ? 'leg end' : ''} due to coverage issue`} />;
            }
            return firstIncompleteLeg == legno ? <Icon type="plane" tooltip="current leg" /> : <Icon type="check" tooltip="leg completed" />;
        };

        const accessor = viewOptions.hcapped ? (l: PilotScoreLeg) => l?.handicapped : (l: PilotScoreLeg) => l?.actual;

        const distanceRemaining = (x) => {
            const l = accessor(x);
            if (l && l.minPossible) {
                return (
                    <td>
                        {l.minPossible} to {l.maxPossible} km
                    </td>
                );
            }
            if (x.legno > 0) {
                return <td>{l.distanceRemaining}</td>;
            }
            return null;
        };

        legs = (
            <>
                <ButtonGroup name="taskleg" role="group" aria-label="task or leg" value={viewOptions.task} className={'smallbuttons goleft'}>
                    {['leg', 'task', 'stats'].map((radio, idx) => (
                        <Button key={idx} variant={idx == viewOptions.task ? 'primary' : 'secondary'} value={idx} onClick={(e) => setViewOptions({...viewOptions, task: idx})}>
                            {radio}
                        </Button>
                    ))}
                </ButtonGroup>

                {hasHandicappedResults ? (
                    <ButtonGroup name="hcapped" role="group" aria-label="actual or handicapped" value={viewOptions.hcapped} className={'smallbuttons goright'}>
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
                                {_map(score.legs, (x) =>
                                    x.legno > 0 ? (
                                        <td>
                                            Leg {x.legno} {legIcon(x.legno, x)}
                                        </td>
                                    ) : null
                                )}
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td>Leg Start</td>
                                {_map(score.legs, (x) => (x.legno > 0 ? <td>{formatTime(x.time, tz)[0]}</td> : null))}
                            </tr>
                            {!viewOptions.task ? (
                                <>
                                    <tr>
                                        <td>Leg Start Altitude</td>
                                        {_map(score.legs, (x) => (x.legno > 0 ? <td>{RoundNumber(x.agl)}</td> : null))}
                                    </tr>
                                    <tr>
                                        <td>Leg Speed</td>
                                        {_map(score.legs, (x) => (x.legno > 0 ? <td>{accessor(x)?.legSpeed}</td> : null))}
                                    </tr>
                                    <tr>
                                        <td>Leg Distance</td>
                                        {_map(score.legs, (x) => (x.legno > 0 ? <td>{accessor(x)?.distance || ''}</td> : null))}
                                    </tr>
                                    <tr>
                                        <td>Leg Remaining</td>
                                        {_map(score.legs, (x) => (x.legno > 0 ? distanceRemaining(x) : null))}
                                    </tr>
                                </>
                            ) : null}
                            {viewOptions.task ? (
                                <>
                                    <tr>
                                        <td>Task Speed</td>
                                        {_map(score.legs, (x) => (x.legno > 0 ? <td>{accessor(x)?.taskSpeed || ''}</td> : null))}
                                    </tr>
                                    <tr>
                                        <td>Task Distance</td>
                                        {_map(score.legs, (x) => (x.legno > 0 ? <td>{accessor(x)?.taskDistance || ''}</td> : null))}
                                    </tr>
                                    {!score.utcFinish && !pilot.utcFinish && (
                                        <tr>
                                            <td>Task Remaining</td>
                                            {_map(score.legs, (x) => (
                                                <td>{x.legno == score.currentLeg ? distanceRemaining(x) : null}</td>
                                            ))}
                                        </tr>
                                    )}
                                </>
                            ) : null}
                        </tbody>
                    </table>
                ) : (
                    <>
                        <br clear="both" />
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
                {OptionalTime('Start ', score.utcStart as Epoch, tz)} {OptionalDuration(' +', score.utcDuration as Epoch, tz)} {OptionalTime(' Finish ', score.utcFinish as Epoch, tz)}
            </div>
        );
    }

    // Figure out what to show based on the db status
    let flightDetails = null;

    if (!score && !vario) {
        flightDetails = <div>No tracking yet</div>;
    } else if (!score.utcStart) {
        flightDetails = (
            <div>
                No start reported yet
                <br />
                {climb}
            </div>
        );
    } else if (score.utcFinish) {
        flightDetails = (
            <div>
                {climb}
                {times}
                {speed}
                <br />
                {legs}
            </div>
        );
    } else {
        flightDetails = (
            <div>
                {climb}
                {times}
                {legs}
                <Optional b="Glide Ratio to Finish" v={score.actual?.grRemaining} e=":1" />
                <Optional b=", HCap Ratio" v={score.handicapped?.grRemaining} e=":1" />
            </div>
        );
    }

    // Check at render if we are up to date or not, delay calculated in sorting which
    // gets updated regularily
    const uptodate = (vario?.delay || Infinity) < 45;

    // Are we in coverage or not, keyed off uptodate
    const ognCoverage = uptodate ? (
        <span>
            <Nbsp />
            <a href="#" style={{color: 'black'}} title="In OGN Flarm coverage">
                <Icon type="check" /> {Math.round(vario?.delay)}s delay
            </a>
        </span>
    ) : (
        <span>
            <Nbsp />
            <a href="#" style={{color: 'grey'}} title="No recent points, waiting for glider to return to coverage">
                {(vario?.delay || Infinity) < 3600 ? (
                    <>
                        <Icon type="spinner" spin={true} />
                        Last point {delayToText(vario.delay)} ago
                    </>
                ) : (
                    <>
                        <Icon type="exclamation" />
                        {(vario?.lat || 0) > 0 ? <>&gt;2 hours ago</> : <>No tracking yet</>}
                    </>
                )}
            </a>
        </span>
    );

    const flag = (pilot.country || '') !== '' ? <div className="details-flag">{isoCountryCodeToFlagEmoji(pilot.country)}</div> : null;

    return (
        <div className="details" style={{paddingTop: '5px'}}>
            {flag}
            <h6>
                {pilot.compno}:<b>{pilot.name}</b> {pilot.gliderType.substring(0, 15)} <div className={'pull-right'}>{false /*track.follow*/ ? <Icon type="screenshot" /> : ''}</div>
                <br />
                <span style={{fontSize: '80%'}}>
                    {ognCoverage}
                    <span>{altitude}</span>
                </span>
            </h6>
            <hr style={{borderColor: 'white', height: '1px', margin: '0'}} />
            {flightDetails}
        </div>
    );
}

function Sorting(props) {
    return (
        <>
            <span className="options">
                <a title="Show Radar" href="#" onClick={() => props.setOptions('radar')}>
                    <Icon type="umbrella" />
                </a>
                <a title="Show Wind Shading" href="#" onClick={() => props.setOptions('windshade')}>
                    <Icon type="magic" />
                </a>
            </span>
            <span className="sorting">
                <a title="Sort Automatically" href="#" onClick={() => props.setSort('auto')}>
                    <Icon type="star" />
                </a>
                <a title="Show Speed" href="#" onClick={() => props.setSort('speed')}>
                    <Icon type="trophy" />
                </a>
                <a title="Show Height" href="#" onClick={() => props.setSort('height')}>
                    <Icon type="cloud-upload " />
                    &nbsp;
                </a>
                <a title="Show Current Climb Average" href="#" onClick={() => props.setSort('climb')}>
                    <Icon type="upload " />
                    &nbsp;
                </a>
                <a title="Show L/D Remaining" href="#" onClick={() => props.setSort('ld')}>
                    <Icon type="fast-forward " />
                    &nbsp;
                </a>
                <a title="Show Distance Done" href="#" onClick={() => props.setSort('distance')}>
                    <Icon type="signout " />
                    &nbsp;
                </a>
                <a title="Show Distance Remaining" href="#" onClick={() => props.setSort('remaining')}>
                    <Icon type="signin " />
                    &nbsp;
                </a>
                <a title="Cycle through times" href="#" onClick={() => props.setSort('times')}>
                    <Icon type="time " />
                    &nbsp;
                </a>
                <Nbsp />

                <a href="#" className="d-lg-inline d-none" onClick={() => props.toggleVisible()} title={props.visible ? 'Hide Results' : 'Show Results'} aria-controls="task-collapse" aria-expanded={props.visible}>
                    <Icon type="tasks" />
                    <Icon type="caret-down" />
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
                <Icon type="spinner" spin={true} />
            </span>
        );
    }

    return (
        <span className="pilotstatus">
            <Icon type={display.icon} spin={false} />
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
