import {memo} from 'react';
import {useTranslation} from 'next-i18next/pages';
import {TooltipIcon} from './htmlhelper';

import {PilotScore, PilotScoreLeg, Compno, Epoch, PositionStatus, TZ} from '../types';

import {useState} from 'react';

import {useSelector} from '../redux';
import {selectPilotStats} from '../redux/scoresSlice';

//import {TZ, Compno, PilotScore, PilotScoreLeg, VarioData, ScoreData, TrackData, Epoch, PositionStatus} from '../types';

//import {API_ClassName_Pilots_PilotDetail, API_ClassName_Pilots} from '../rest-api-types';

import {OptionalTimeHHMM, OptionalDurationHHMM} from './optional';
import {displayHeight} from './displayunits';

import {FlightStatsSegments} from './flightStatsSegments';

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


export const FlightLegs = memo(function FlightLegs({compno, score, units, tz, replayTime}: {compno: Compno; score: any; units: boolean; tz: TZ; replayTime?: Epoch}) {
    const {t} = useTranslation('common');
    const [viewOptions, setViewOptions] = useState({view: 'statistics', hcapped: 0});

    // Per-pilot flight-statistics segments (thermals/glides/gaps). Keyed to
    // trackVersion, delivered on the stats data plane — see selectPilotStats.
    const segments = useSelector((state) => selectPilotStats(state, compno));

    if (!score?.legs) {
        return <></>;
    }

    const legIcon = (leg) => {
        if (leg.legno == score.currentLeg) {
            if (score.utcFinish) {
                return <TooltipIcon icon={faTrophy} tooltip={t('flight_legs.finished')} />;
            } else if (score.flightStatus == PositionStatus.Landed) {
                return <TooltipIcon icon={faCow} tooltip={t('flight_legs.landout_on_leg')} />;
            } else if (score.flightStatus == PositionStatus.Home) {
                return <TooltipIcon icon={faHouse} tooltip={t('flight_legs.returned_home')} />;
            } else if (score.inSector || score.inPenalty) {
                return <TooltipIcon icon={faLocationCrosshairs} tooltip={t('flight_legs.in_sector')} fade style={{animationDuration: '10s'}} />;
            }
            return <TooltipIcon icon={faPaperPlane} tooltip={t('flight_legs.heading_to_sector')} fade style={{animationDuration: '10s'}} />;
        }
        if (leg.legno > score.currentLeg) {
            return <TooltipIcon icon={faHourglassStart} tooltip={t('flight_legs.leg_not_started')} size="xs" />;
        } else if (leg.estimatedStart || leg.estimatedEnd) {
            const which = `${leg.estimatedStart ? t('flight_legs.estimated_start') : ''}${leg.estimatedEnd ? t('flight_legs.estimated_end') : ''}`;
            return <TooltipIcon icon={faSignal} tooltip={t('flight_legs.estimated_warning', {which})} />;
        }
        return <TooltipIcon icon={faSquareCheck} tooltip={t('flight_legs.leg_completed')} />;
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
                    {t('flight_legs.possible')}
                    <br />
                    {t('flight_legs.shortest')}
                </td>
            );
        }
        if (l.distanceRemaining > 0) {
            return <td key="legend">{t('flight_legs.shortest')}</td>;
        }
        return null;
    };

    const actualLegs = (Object.values(score.legs) as PilotScoreLeg[]).filter((f) => f.legno != 0);
    const hasHandicappedResults = score?.handicapped;

    // Statistics is the first/default view, but only appears once segments have
    // been computed for the pilot (it has nothing to show otherwise).
    const hasStats = !!segments?.length;
    const taskRadios: {key: string; label: string}[] = [];
    if (hasStats) {
        taskRadios.push({key: 'statistics', label: t('flight_legs.view_statistics')});
    }
    taskRadios.push({key: 'leg', label: t('flight_legs.view_leg')});
    taskRadios.push({key: 'task', label: t('flight_legs.view_task')});

    // Fall back to the task table when statistics is selected (the default) but
    // not yet available; once segments arrive the view switches to it on its own.
    const activeView = viewOptions.view == 'statistics' && !hasStats ? 'task' : viewOptions.view;

    const hcapRadios: {key: string; label: string}[] = [
        {key: 'actuals', label: t('flight_legs.view_actuals')},
        {key: 'handicapped', label: t('flight_legs.view_handicapped')}
    ];

    return (
        <>
            <br style={{clear: 'both'}} />
            <div className="btn-group-mini" role="group" aria-label={t('flight_legs.view_task_or_leg')} style={{float: 'left'}}>
                {taskRadios.map((radio) => (
                    <button key={radio.key} className={radio.key == activeView ? 'active' : ''} onClick={() => setViewOptions({...viewOptions, view: radio.key})}>
                        {radio.label}
                    </button>
                ))}
            </div>

            {hasHandicappedResults && activeView != 'statistics' ? (
                <div className="btn-group-mini" role="group" aria-label={t('flight_legs.view_actual_or_handicapped')} style={{float: 'right'}}>
                    {hcapRadios.map((radio, idx) => (
                        <button
                            key={radio.key}
                            className={idx == viewOptions.hcapped ? 'active' : ''}
                            onClick={() => {
                                setViewOptions({...viewOptions, hcapped: idx});
                            }}
                        >
                            {radio.label}
                        </button>
                    ))}
                </div>
            ) : null}

            {activeView != 'statistics' ? (
                <table className="legs">
                    <thead>
                        <tr>
                            <td>&nbsp;</td>
                            {actualLegs.map((x) => (
                                <td key={x.legno.toString()}>
                                    {t('task.leg', {n: x.legno})} {legIcon(x)}
                                </td>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        <tr style={{fontSize: 'small'}}>
                            <td>{t('flight_legs.leg_start_altitude')}</td>
                            {actualLegs.map((x) => (x?.alt > 0 ? <td key={x.legno.toString()}>{displayHeight(x?.alt, units)}</td> : null))}
                        </tr>
                        <tr>
                            <td>{t('flight_legs.leg_start')}</td>
                            {actualLegs.map((x) => (x.time ? <td key={x.legno.toString()}>{OptionalTimeHHMM('', x.time as Epoch, tz)}</td> : null))}
                        </tr>
                        <tr style={{fontSize: 'small'}}>
                            <td>{t('flight_legs.leg_duration')}</td>
                            {actualLegs.map((x) => (x.duration ? <td key={x.legno.toString()}>{OptionalDurationHHMM('+', x.duration as Epoch)}</td> : null))}
                        </tr>
                        {activeView == 'leg' ? (
                            <>
                                <tr>
                                    <td>{t('flight_legs.leg_distance')}</td>
                                    {actualLegs.map((x) => (
                                        <td key={x.legno.toString()}>{accessor(x)?.distance || ''}</td>
                                    ))}
                                </tr>
                                <tr>
                                    <td>{t('flight_legs.leg_speed')}</td>
                                    {actualLegs.map((x) => (
                                        <td key={x.legno.toString()}>{accessor(x)?.legSpeed}</td>
                                    ))}
                                </tr>
                                {!score.utcFinish && (
                                    <tr>
                                        {distanceRemainingLegend(score)}
                                        {actualLegs.map((x) => (x.legno >= score.currentLeg ? distanceRemaining(x) : <td key={x.legno.toString()}></td>))}
                                    </tr>
                                )}
                            </>
                        ) : null}
                        {activeView == 'task' ? (
                            <>
                                <tr>
                                    <td>{t('flight_legs.task_speed')}</td>
                                    {actualLegs.map((x) => (
                                        <td key={x.legno.toString()}>{accessor(x)?.taskSpeed || ''}</td>
                                    ))}
                                </tr>
                                <tr>
                                    <td>{t('flight_legs.task_distance')}</td>
                                    {actualLegs.map((x) => (
                                        <td key={x.legno.toString()}>{accessor(x)?.taskDistance || ''}</td>
                                    ))}
                                </tr>
                                {!score.utcFinish && (
                                    <tr>
                                        {distanceRemainingLegend(score)}
                                        {actualLegs.map((x) => (x.legno == score.currentLeg ? distanceRemaining(score) : <td key={x.legno.toString()} />))}
                                    </tr>
                                )}
                            </>
                        ) : null}
                    </tbody>
                </table>
            ) : null}
            {activeView == 'statistics' && hasStats ? <FlightStatsSegments segments={segments} utcStart={score.utcStart as Epoch} scoredDistance={score.actual?.taskDistance} replayTime={replayTime} units={units} tz={tz} /> : null}
        </>
    );
});
