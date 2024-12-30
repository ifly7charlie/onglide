import {memo} from 'react';
import {TooltipIcon} from './htmlhelper';

import {PilotScore, PilotScoreLeg, Epoch, PositionStatus, TZ} from '../types';

import {useState} from 'react';

//import {TZ, Compno, PilotScore, PilotScoreLeg, VarioData, ScoreData, TrackData, Epoch, PositionStatus} from '../types';

//import {API_ClassName_Pilots_PilotDetail, API_ClassName_Pilots} from '../rest-api-types';

import {OptionalTimeHHMM, OptionalDurationHHMM} from './optional';
import {displayHeight} from './displayunits';

import ButtonGroup from 'react-bootstrap/ButtonGroup';

import Button from 'react-bootstrap/Button';

import {
    //
    faCow,
    faHouse,
    faHourglassStart,
    faLocationCrosshairs,
    faPaperPlane,
    faSignal,
    faSquareCheck,
    faTrophy
} from '@fortawesome/free-solid-svg-icons';

import {find as _find, filter as _filter, sortBy as _sortby, clone as _clone, map as _map} from 'lodash';

export const FlightLegs = memo(function FlightLegs({score, units, tz}: {score: any; units: boolean; tz: TZ}) {
    const [viewOptions, setViewOptions] = useState({task: 1, hcapped: 0});

    if (!score?.legs) {
        return <></>;
    }

    const legIcon = (leg) => {
        if (leg.legno == score.currentLeg) {
            if (score.utcFinish) {
                return <TooltipIcon icon={faTrophy} tooltip="Finished!" />;
            } else if (score.flightStatus == PositionStatus.Landed) {
                return <TooltipIcon icon={faCow} tooltip="Landout on leg" />;
            } else if (score.flightStatus == PositionStatus.Home) {
                return <TooltipIcon icon={faHouse} tooltip="Returned home" />;
            } else if (score.inSector || score.inPenalty) {
                return <TooltipIcon icon={faLocationCrosshairs} tooltip="plane in sector" fade style={{animationDuration: '10s'}} />;
            }
            return <TooltipIcon icon={faPaperPlane} tooltip="plane still heading to sector" fade style={{animationDuration: '10s'}} />;
        }
        if (leg.legno > score.currentLeg) {
            return <TooltipIcon icon={faHourglassStart} tooltip="leg not started yet" size="xs" />;
        } else if (leg.estimatedStart || leg.estimatedEnd) {
            return <TooltipIcon icon={faSignal} tooltip={`warning: estimated ${leg.estimatedStart ? 'leg start ' : ''}${leg.estimatedEnd ? 'leg end' : ''} due to coverage issue`} />;
        }
        return <TooltipIcon icon={faSquareCheck} tooltip="leg completed" />;
    };

    const accessor = viewOptions.hcapped ? (l: PilotScoreLeg | PilotScore) => l?.handicapped : (l: PilotScoreLeg | PilotScore) => l?.actual;

    const distanceRemaining = (x) => {
        const l = accessor(x);
        if (!l) {
            return null;
        }
        if (l.maxPossible && l.minPossible && Math.round(l.minPossible) != Math.round(l.maxPossible)) {
            return (
                <td style={{fontSize: 'small'}} key="mp_dr">
                    {Math.round(l.minPossible)}-{Math.round(l.maxPossible)}
                    <br />
                    {l.distanceRemaining}
                </td>
            );
        }
        if (l.maxPossible) {
            return (
                <td style={{fontSize: 'small'}} key="mp">
                    {l.maxPossible}
                    <br />
                    {l.distanceRemaining}
                </td>
            );
        }
        if (l.distanceRemaining > 0) {
            return <td key="dr">{l.distanceRemaining}</td>;
        }
        return null;
    };
    const distanceRemainingLegend = (x) => {
        const l = accessor(x);
        if (l && l.maxPossible) {
            return (
                <td style={{fontSize: 'small'}} key="legend">
                    Possible
                    <br />
                    Shortest
                </td>
            );
        }
        if (l.distanceRemaining > 0) {
            return <td key="legend">Shortest</td>;
        }
        return null;
    };

    const actualLegs = _filter(score.legs, (f) => f.legno != 0);
    const hasHandicappedResults = score?.handicapped;

    return (
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
                            <td>&nbsp;</td>
                            {_map(actualLegs, (x) => (
                                <td key={x.legno.toString()}>
                                    Leg {x.legno} {legIcon(x)}
                                </td>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        <tr style={{fontSize: 'small'}}>
                            <td>Leg Start Altitude</td>
                            {_map(actualLegs, (x) => (x?.alt > 0 ? <td key={x.legno.toString()}>{displayHeight(x?.alt, units)}</td> : null))}
                        </tr>
                        <tr>
                            <td>Leg Start</td>
                            {_map(actualLegs, (x) => (x.time ? <td key={x.legno.toString()}>{OptionalTimeHHMM('', x.time as Epoch, tz)}</td> : null))}
                        </tr>
                        <tr style={{fontSize: 'small'}}>
                            <td>Leg Duration</td>
                            {_map(actualLegs, (x) => (x.duration ? <td key={x.legno.toString()}>{OptionalDurationHHMM('+', x.duration as Epoch)}</td> : null))}
                        </tr>
                        {!viewOptions.task ? (
                            <>
                                <tr>
                                    <td>Leg Distance</td>
                                    {_map(actualLegs, (x) => (
                                        <td key={x.legno.toString()}>{accessor(x)?.distance || ''}</td>
                                    ))}
                                </tr>
                                <tr>
                                    <td>Leg Speed</td>
                                    {_map(actualLegs, (x) => (
                                        <td key={x.legno.toString()}>{accessor(x)?.legSpeed}</td>
                                    ))}
                                </tr>
                                {!score.utcFinish && (
                                    <tr>
                                        {distanceRemainingLegend(score)}
                                        {_map(actualLegs, (x) => (x.legno >= score.currentLeg ? distanceRemaining(x) : <td key={x.legno.toString()}></td>))}
                                    </tr>
                                )}
                            </>
                        ) : null}
                        {viewOptions.task ? (
                            <>
                                <tr>
                                    <td>Task Speed</td>
                                    {_map(actualLegs, (x) => (
                                        <td key={x.legno.toString()}>{accessor(x)?.taskSpeed || ''}</td>
                                    ))}
                                </tr>
                                <tr>
                                    <td>Task Distance</td>
                                    {_map(actualLegs, (x) => (
                                        <td key={x.legno.toString()}>{accessor(x)?.taskDistance || ''}</td>
                                    ))}
                                </tr>
                                {!score.utcFinish && (
                                    <tr>
                                        {distanceRemainingLegend(score)}
                                        {_map(actualLegs, (x) => (x.legno == score.currentLeg ? distanceRemaining(score) : <td key={x.legno.toString()} />))}
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
});
