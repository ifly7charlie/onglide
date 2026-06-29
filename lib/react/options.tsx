import type {CSSProperties} from 'react';
import {useMeasure} from './measure';
import {useTranslation} from 'next-i18next/pages';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';

import {useSelector} from '../redux';
import {selectHasStats} from '../redux/scoresSlice';

import {
    faRuler,
    faSlash,
    faCloudShowersHeavy,
    faCompassDrafting,
    faMap,
    faGlobe,
    faLocationCrosshairs,
    faRoute, //
    faUsers,
    fa1,
    faRoad,
    faSatellite,
    faPersonArrowUpFromLine,
    faPeopleArrows
} from '@fortawesome/free-solid-svg-icons';
import {faCompass, faHandPointer, faCircleUp} from '@fortawesome/free-regular-svg-icons';

import type {Options as OptionsType} from '../types';

// The +Xmin / off label is overlaid on the umbrella icon — bottom-aligned and
// nudged 2px right of centre — so it sits on the icon rather than widening the
// toolbar button (which was causing the layout issues).
const rainTimeStyle: CSSProperties = {
    position: 'absolute',
    top: 2,
    left: '50%',
    transform: 'translateX(-50%)',
    fontSize: '9px',
    lineHeight: 1,
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    color: 'white',
    background: 'transparent'
};

export function Options(props: {options: OptionsType; setOptions: Function; multipleClasses: boolean; showRainRadar?: boolean}) {
    const {enabled: measureEnabled, toggle: toggleMeasure} = useMeasure();
    const {t} = useTranslation('common', {keyPrefix: 'options'});

    // Climb-rate map badges read flight-statistics segments; with no stats there
    // is nothing to show, so hide the toggle entirely (same signal the stats tab
    // uses). True once any pilot has stats — i.e. the comp has them enabled.
    const hasStats = useSelector(selectHasStats);

    const radarFunction = () => {
        let nextRadar = props.options.rainRadarAdvance + 1;
        let rainRadar = props.options.rainRadar;
        if (!rainRadar) {
            rainRadar = true;
            nextRadar = 0;
        }
        if (nextRadar >= 4) {
            nextRadar = 0;
            rainRadar = false;
        }
        props.setOptions(structuredClone({...props.options, rainRadarAdvance: nextRadar, rainRadar}));
    };
    const constructionLines = () => {
        props.setOptions(structuredClone({...props.options, constructionLines: !props.options.constructionLines}));
    };
    const toggle2d = () => {
        const newOptions = structuredClone({...props.options, map2d: !props.options.map2d});
        // Save away the current options and
        if (props.options.map2d) {
            Object.assign(newOptions, {options2d: {taskUp: newOptions.taskUp, follow: newOptions.follow, mapType: newOptions.mapType}});
            Object.assign(newOptions, {...(props.options.options3d ?? {taskUp: 1, mapType: 1})});
        } else {
            Object.assign(newOptions, {options3d: {taskUp: newOptions.taskUp, follow: newOptions.follow, mapType: newOptions.mapType}});
            Object.assign(newOptions, {...(props.options.options2d ?? {taskUp: 0, mapType: 0})});
        }
        props.setOptions(newOptions);
    };
    const toggleSatellite = () => {
        props.setOptions(structuredClone({...props.options, mapType: !props.options.mapType}));
    };
    const toggleUnits = () => {
        props.setOptions(structuredClone({...props.options, units: !props.options.units}));
    };
    const toggleTaskUp = () => {
        props.setOptions(structuredClone({...props.options, taskUp: (props.options.taskUp + 1) % 3}));
    };
    const toggleFollow = () => {
        props.setOptions(structuredClone({...props.options, follow: !props.options.follow}));
    };
    const toggleFullPaths = () => {
        props.setOptions(structuredClone({...props.options, fullPaths: (props.options.fullPaths + 1) % 3}));
    };
    const toggleShowOthers = () => {
        props.setOptions(structuredClone({...props.options, showOthers: !props.options.showOthers}));
    };
    const toggleShowClimb = () => {
        props.setOptions(structuredClone({...props.options, showClimb: !props.options.showClimb}));
    };
    const toggleCompare = () => {
        props.setOptions(structuredClone({...props.options, comparePilots: !props.options.comparePilots}));
    };

    // Indexed by rainRadarAdvance (0 = latest observed, 1-3 = nowcast +10/+20/+30 min)
    const rainLabels = [t('rain_now'), t('rain_plus_10'), t('rain_plus_20'), t('rain_plus_30')];
    const rainIconLabels = rainLabels.map((l) => l.replace('min', ''));

    return (
        <div className="options">
            {measureEnabled ? (
                <button title={t('measure_active')} onClick={() => toggleMeasure?.()}>
                    <FontAwesomeIcon icon={faRuler} />
                </button>
            ) : (
                <button title={t('measure_off')} onClick={() => toggleMeasure?.()}>
                    <span className="fa-layers">
                        <FontAwesomeIcon icon={faSlash} />
                        <FontAwesomeIcon icon={faRuler} />
                    </span>
                </button>
            )}
            {/* Rain radar relies on the live OGN feed, so it is hidden on the replay viewer */}
            {(props.showRainRadar ?? true) ? (
                <>
                    {props.options.rainRadar ? (
                        <button title={t('rain_radar_showing', {value: rainLabels[props.options.rainRadarAdvance]})} onClick={radarFunction}>
                            <span className="fa-layers">
                                <FontAwesomeIcon icon={faCloudShowersHeavy} transform="grow-3" />
                                <span style={rainTimeStyle}>{rainIconLabels[props.options.rainRadarAdvance]}</span>
                            </span>
                        </button>
                    ) : (
                        <button title={t('rain_radar_enable')} onClick={radarFunction}>
                            <span className="fa-layers">
                                <FontAwesomeIcon icon={faSlash} />
                                <FontAwesomeIcon icon={faCloudShowersHeavy} transform="grow-3" />
                                <span style={rainTimeStyle}>{t('rain_off')}</span>
                            </span>
                        </button>
                    )}
                </>
            ) : null}
            {props.options.constructionLines ? (
                <button title={t('construction_lines_hide')} onClick={constructionLines}>
                    <FontAwesomeIcon icon={faCompassDrafting} />
                </button>
            ) : (
                <button title={t('construction_lines_show')} onClick={constructionLines}>
                    <span className="fa-layers">
                        <FontAwesomeIcon icon={faSlash} />
                        <FontAwesomeIcon icon={faCompassDrafting} />
                    </span>
                </button>
            )}
            {props.options.map2d ? (
                <button title={t('switch_to_3d')} onClick={toggle2d}>
                    <FontAwesomeIcon icon={faMap} />
                </button>
            ) : (
                <button title={t('switch_to_2d')} onClick={toggle2d}>
                    <FontAwesomeIcon icon={faGlobe} />
                </button>
            )}
            {false ? <br className="smallScreen" /> : null}
            {props.options.mapType ? (
                <button title={t('road_to_satellite')} onClick={toggleSatellite}>
                    <FontAwesomeIcon icon={faSatellite} />
                </button>
            ) : (
                <button title={t('satellite_to_road')} onClick={toggleSatellite}>
                    <FontAwesomeIcon icon={faRoad} />
                </button>
            )}
            {
                [
                    <button title={t('north_up')} onClick={toggleTaskUp}>
                        <FontAwesomeIcon icon={faCompass} transform={{rotate: -45}} />
                    </button>,
                    <button title={t('task_track_up')} onClick={toggleTaskUp}>
                        <FontAwesomeIcon icon={faPersonArrowUpFromLine} />
                    </button>,
                    <button title={t('manual_orientation')} onClick={toggleTaskUp}>
                        <FontAwesomeIcon icon={faHandPointer} />
                    </button>
                ][props.options.taskUp || 0]
            }
            {props.options.follow ? (
                <button title={t('follow_pilot')} onClick={toggleFollow}>
                    <FontAwesomeIcon icon={faLocationCrosshairs} />
                </button>
            ) : (
                <button title={t('follow_disabled')} onClick={toggleFollow}>
                    <span className="fa-layers">
                        <FontAwesomeIcon icon={faSlash} />
                        <FontAwesomeIcon icon={faLocationCrosshairs} />
                    </span>
                </button>
            )}
            {
                [
                    <button title={t('paths_recent')} onClick={toggleFullPaths}>
                        <span className="fa-layers">
                            <FontAwesomeIcon icon={faSlash} />
                            <FontAwesomeIcon icon={faRoute} />
                        </span>
                    </button>,
                    <button title={t('paths_selected_full')} onClick={toggleFullPaths}>
                        <span className="fa-layers">
                            <FontAwesomeIcon icon={faRoute} />
                            <FontAwesomeIcon icon={fa1} transform="shrink-8 left-4 up-4" />
                        </span>
                    </button>,
                    <button title={t('paths_all_full')} onClick={toggleFullPaths}>
                        <FontAwesomeIcon icon={faRoute} />
                    </button>
                ][props.options.fullPaths || 0]
            }
            {props.options.comparePilots ? (
                <button title={t('compare_active')} onClick={toggleCompare}>
                    <FontAwesomeIcon icon={faPeopleArrows} />
                </button>
            ) : (
                <button title={t('compare_off')} onClick={toggleCompare}>
                    <span className="fa-layers">
                        <FontAwesomeIcon icon={faSlash} />
                        <FontAwesomeIcon icon={faPeopleArrows} />
                    </span>
                </button>
            )}
            {!hasStats ? null : props.options.showClimb ? (
                <button title={t('climb_hide')} onClick={toggleShowClimb}>
                    <FontAwesomeIcon icon={faCircleUp} />
                </button>
            ) : (
                <button title={t('climb_show')} onClick={toggleShowClimb}>
                    <span className="fa-layers">
                        <FontAwesomeIcon icon={faSlash} />
                        <FontAwesomeIcon icon={faCircleUp} />
                    </span>
                </button>
            )}
            {!props.multipleClasses ? null : props.options.showOthers ? (
                <button title={t('show_other_classes')} onClick={toggleShowOthers}>
                    <span className="fa-layers">
                        <FontAwesomeIcon icon={faUsers} />
                    </span>
                </button>
            ) : (
                <button title={t('show_only_current')} onClick={toggleShowOthers}>
                    <span className="fa-layers">
                        <FontAwesomeIcon icon={faSlash} />
                        <FontAwesomeIcon icon={faUsers} />
                    </span>
                </button>
            )}
            {props.options.units ? (
                <button title={t('switch_to_metric')} onClick={toggleUnits} className="units-toggle">
                    ft
                </button>
            ) : (
                <button title={t('switch_to_imperial')} onClick={toggleUnits} className="units-toggle">
                    m
                </button>
            )}
        </div>
    );
}
