import {useMeasure} from './measure';
import {useTranslation} from 'next-i18next/pages';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';

import {useSelector} from '../redux';
import {selectHasStats} from '../redux/scoresSlice';

import {
    faRuler,
    faSlash,
    faUmbrella,
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

export function Options(props: {options: OptionsType; setOptions: Function; multipleClasses: boolean}) {
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
            {/* Rain radar temporarily disabled — upstream tiles not working.
            {props.options.rainRadar ? (
                <button title={'Adjust rain radar timings, currently showing ' + ['now', '+10min', '+20min', '+30min'][props.options.rainRadarAdvance] + ', click to change timing or disable'} onClick={radarFunction}>
                    <FontAwesomeIcon icon={faUmbrella} />
                    &nbsp;
                    <span style={{fontSize: '9px'}}>{['now', '+10min', '+20min', '+30min'][props.options.rainRadarAdvance]}</span>
                </button>
            ) : (
                <button title={'Click to enable rain radar'} onClick={radarFunction}>
                    <span className="fa-layers">
                        <FontAwesomeIcon icon={faSlash} />
                        <FontAwesomeIcon icon={faUmbrella} />
                    </span>
                    &nbsp;
                    <span style={{fontSize: '9px'}}>{['off', 'now', '+10min', '+20min', '+30min'][props.options.rainRadarAdvance]}</span>
                </button>
            )}
            &nbsp;
            */}
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
            &nbsp;
            {props.options.map2d ? (
                <button title={t('switch_to_3d')} onClick={toggle2d}>
                    <FontAwesomeIcon icon={faMap} />{' '}
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
            &nbsp;
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
            &nbsp;
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
            &nbsp;
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
            &nbsp;
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
            &nbsp;
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
            &nbsp;
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
