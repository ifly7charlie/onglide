import {UseMeasure, toggleMeasure, isMeasuring} from './measure';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {solid, regular} from '@fortawesome/fontawesome-svg-core/import.macro';
import {cloneDeep as _cloneDeep} from 'lodash';

export function Options(props: {options: any; setOptions: Function; measureFeatures: UseMeasure}) {
    const radarFunction = () => {
        const nextRadar = (props.options.rainRadarAdvance + 1) % 4;
        props.setOptions(_cloneDeep({...props.options, rainRadarAdvance: nextRadar}));
    };
    const constructionLines = () => {
        props.setOptions(_cloneDeep({...props.options, constructionLines: !props.options.constructionLines}));
    };
    const toggle3d = () => {
        props.setOptions(_cloneDeep({...props.options, mapType: props.options.mapType ^ 2}));
    };
    const toggleSatellite = () => {
        props.setOptions(_cloneDeep({...props.options, mapType: props.options.mapType ^ 1}));
    };
    const toggleUnits = () => {
        props.setOptions(_cloneDeep({...props.options, units: !props.options.units}));
    };
    const toggleTaskUp = () => {
        props.setOptions(_cloneDeep({...props.options, taskUp: (props.options.taskUp + 1) % 3}));
    };
    const toggleFollow = () => {
        props.setOptions(_cloneDeep({...props.options, follow: !props.options.follow}));
    };
    const toggleFullPaths = () => {
        props.setOptions(_cloneDeep({...props.options, fullPaths: !props.options.fullPaths}));
    };

    return (
        <div className="options">
            <button title={'Adjust rain radar timings, currently showing ' + ['now', '+10min', '+20min', '+30min'][props.options.rainRadarAdvance]} onClick={radarFunction}>
                <FontAwesomeIcon icon={solid('umbrella')} />
                &nbsp;
                <span style={{fontSize: '9px'}}>{['now', '+10min', '+20min', '+30min'][props.options.rainRadarAdvance]}</span>
            </button>
            &nbsp;
            {!isMeasuring(props.measureFeatures) ? (
                <button title="Click to measure" onClick={toggleMeasure(props.measureFeatures)}>
                    <FontAwesomeIcon icon={solid('ruler')} />
                </button>
            ) : (
                <button title="Click to stop measuring" onClick={toggleMeasure(props.measureFeatures)}>
                    <span className="fa-layers">
                        <FontAwesomeIcon icon={solid('slash')} />
                        <FontAwesomeIcon icon={solid('ruler')} />
                    </span>
                </button>
            )}
            &nbsp;
            {props.options.constructionLines ? (
                <button title="Click to hide Construction Lines" onClick={constructionLines}>
                    <FontAwesomeIcon icon={solid('compass-drafting')} />
                </button>
            ) : (
                <button title="Click to show Construction Lines" onClick={constructionLines}>
                    <span className="fa-layers">
                        <FontAwesomeIcon icon={solid('slash')} />
                        <FontAwesomeIcon icon={solid('compass-drafting')} />
                    </span>
                </button>
            )}
            &nbsp;
            {props.options.mapType & 2 ? (
                <button title="Displaying 2D, Click to switch to 3D" onClick={toggle3d}>
                    <FontAwesomeIcon icon={solid('map')} />{' '}
                </button>
            ) : (
                <button title="Displaying 3D, Click to switch to 2D" onClick={toggle3d}>
                    <FontAwesomeIcon icon={solid('globe')} />
                </button>
            )}
            <br className="smallScreen" />
            {props.options.mapType & 1 ? (
                <button title="Displaying road map, Click to switch to satellite map" onClick={toggleSatellite}>
                    <FontAwesomeIcon icon={solid('road')} />
                </button>
            ) : (
                <button title="Displaying satellite map, Click to switch to road map" onClick={toggleSatellite}>
                    <FontAwesomeIcon icon={solid('satellite')} />
                </button>
            )}
            &nbsp;
            {
                [
                    <button title="Map rientation is currently locked to North Up, Change to Task Track Up when following" onClick={toggleTaskUp}>
                        <FontAwesomeIcon icon={regular('compass')} transform={{rotate: -45}} />
                    </button>,
                    <button title="Follow orientation is currently Task Track Up, Change to Manual (user controlled)" onClick={toggleTaskUp}>
                        <FontAwesomeIcon icon={solid('person-arrow-up-from-line')} />
                    </button>,
                    <button title="Follow orientation is currently Manual (user controlled), Change to be always North Up" onClick={toggleTaskUp}>
                        <FontAwesomeIcon icon={regular('hand-pointer')} />
                    </button>
                ][props.options.taskUp || 0]
            }
            &nbsp;
            {props.options.follow ? (
                <button title="Will follow selected pilot, Click to leave map alone when selecting a pilot" onClick={toggleFollow}>
                    <FontAwesomeIcon icon={solid('location-crosshairs')} />
                </button>
            ) : (
                <button title="Do not follow selected pilot, Click to follow" onClick={toggleFollow}>
                    <span className="fa-layers">
                        <FontAwesomeIcon icon={solid('slash')} />
                        <FontAwesomeIcon icon={solid('location-crosshairs')} />
                    </span>
                </button>
            )}
            &nbsp;
            {props.options.fullPaths ? (
                <button title="Show full paths for all pilots" onClick={toggleFullPaths}>
                    <FontAwesomeIcon icon={solid('route')} />
                </button>
            ) : (
                <button title="Show recent paths for all pilots" onClick={toggleFullPaths}>
                    <span className="fa-layers">
                        <FontAwesomeIcon icon={solid('slash')} />
                        <FontAwesomeIcon icon={solid('route')} />
                    </span>
                </button>
            )}
            &nbsp;
            {props.options.units ? (
                <button title="Switch to metric units" onClick={toggleUnits}>
                    <span className="fa-layers">ft</span>
                </button>
            ) : (
                <button title="Switch to imperial units" onClick={toggleUnits}>
                    m
                </button>
            )}
        </div>
    );
}
