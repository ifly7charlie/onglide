import {memo, useMemo} from 'react';
import {useTranslation} from 'next-i18next/pages';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {
    faBackward,
    faBatteryFull,
    faBatteryThreeQuarters,
    faBatteryHalf,
    faBatteryQuarter,
    faBatteryEmpty,
    faCircleArrowUp,
    faCircleArrowDown,
    faCircleArrowRight,
    faCirclePause,
    faClock,
    faClockRotateLeft,
    faCloudArrowDown,
    faCloudUpload,
    faCow,
    faHistory,
    faHome,
    faHourglassStart,
    faHourglassHalf,
    faHourglassEnd,
    faHouse,
    faLocationArrow,
    faPaperPlane,
    faPenToSquare,
    faQuestion, //
    faEyeSlash,
    faRightFromBracket,
    faRightToBracket,
    faSignal,
    faSpinner,
    faSquareCheck,
    faStopwatch,
    faTachometerAlt,
    faTriangleExclamation,
    faTrophy,
    faWind,
    IconDefinition
} from '@fortawesome/free-solid-svg-icons';

import {TZ, Compno, Units, PilotScore, VarioData, ScoreData, TrackData, Epoch, PositionStatus, Options, SortKey} from '../types';

import {API_ClassName_Pilots_PilotDetail, API_ClassName_Pilots} from '../rest-api-types';

import {Optional, OptionalTime, OptionalDuration, OptionalDurationMM} from './optional';
import {useState, useCallback} from 'react';

import {FlightLegs} from './flightLegs';

// Helpers for loading contest information etc
import {delayToText} from './timehelper.js';

import {useSelector} from '../redux';
import {selectPilotScore, selectAllStatus} from '../redux/scoresSlice';
import {selectPilotVario} from '../redux/tracksSlice';
import {selectLatestUpdate} from '../redux/tracksSlice';
import {sortKeyEqualityCheck, sortOrders, type AllNormalDisplayKeys} from '../redux/selectPilotResult';

// Helpers for sorting pilot list
import {getValidSortOrder} from './pilot-sorting';
import {displayHeight, convertHeight, convertClimb} from './displayunits';

import {offlineTime} from '../constants';

function isoCountryCodeToFlagEmoji(country: string) {
    return String.fromCodePoint(...[...country].map((c) => c.charCodeAt(0) + 0x1f1a5));
}

const icons: IconDefinition[] = [
    faSignal, // Unknown = 0,
    faCirclePause, // Stationary = 1,
    faClock, // Grid = 2,
    faPaperPlane, // Low
    faPaperPlane, // Airborne
    faHouse, // Home
    faCow, // Landed
    faTrophy, // Finished
    faEyeSlash // Blocked = 8 (DDB Permit-Livetracking declined)
];

// Figure out what image to display for the pilot. If they have an image then display the thumbnail for it,
// if they have a country then overlay that on the corner.
function PilotImage(props) {
    if (props.image && props.image == 'Y') {
        return (
            <div className="ih" style={{backgroundImage: `url(/api/${props.class}/image?compno=${props.compno})`}}>
                {props.country ? <div className="icountry">{isoCountryCodeToFlagEmoji(props.country)}</div> : null}
            </div>
        );
    }
    if (props.image) {
        return (
            <div className="ih" style={{backgroundImage: `url(//www.gravatar.com/avatar/${props.image}?d=robohash)`}}>
                {props.country ? <div className="icountry">{isoCountryCodeToFlagEmoji(props.country)}</div> : null}
            </div>
        );
    }
    if (props.country) {
        return <div className="ihi">{isoCountryCodeToFlagEmoji(props.country)}</div>;
    }

    return <div className="ih" style={{backgroundImage: `url(/outline.gif)`}} />;
}

function sanitize(n: any) {
    if (typeof n === 'number' && isNaN(n)) {
        return '-';
    }
    return n;
}

function SummaryComponent({id, title, titleIcon, main, data1, data2, width}: any) {
    return (
        <li id={id} style={{width}}>
            <a href="#" title={title} onClick={() => {}}>
                <div className="caption">
                    {title}
                    {titleIcon || null}
                </div>
            </a>
            <hr />
            <div className="summarycomponent">
                <div className="main-text">{sanitize(main.value)}</div>
                {main.units ? <div className="units">{main.units}</div> : null}
                <div className="main-icon">
                    <a href="#" title={main.description} className="tooltipicon">
                        <FontAwesomeIcon icon={main.icon} />
                    </a>
                </div>
            </div>
            <hr />
            {data1?.value != undefined ? (
                <div className="summarycomponent">
                    <div className="data-text">{sanitize(data1.value)}</div>
                    {data1.units ? <div className="units">{data1.units}</div> : null}
                    <div className="data-icon">
                        <a href="#" title={data1.description} className="tooltipicon">
                            <FontAwesomeIcon icon={data1.icon} style={data1.iconStyle} />
                        </a>
                    </div>
                </div>
            ) : null}
            {data2?.value !== undefined && data2.value !== null ? (
                <div className="summarycomponent">
                    <div className="data-text">{sanitize(data2.value)}</div>
                    {data2.units ? <div className="units">{data2.units}</div> : null}
                    {data2.icon ? (
                        <div className="data-icon">
                            <a href="#" title={data2.description} className="tooltipicon">
                                <FontAwesomeIcon icon={data2.icon} />
                            </a>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </li>
    );
}

function ClimbComponent({units, vario}: {units: boolean; vario: VarioData}) {
    const {t} = useTranslation('common');
    const howMuchClimb = vario //
        ? vario.average > 0.2
            ? faCircleArrowUp
            : vario.average < -0.2
              ? faCircleArrowDown
              : faCircleArrowRight
        : faQuestion;

    const convertedClimb = convertClimb(vario?.average ?? 0, units);

    return vario?.valid ? (
        <SummaryComponent
            id="climb"
            title={t('pilot_metric.vario')} //
            main={{value: !isNaN(convertedClimb[0]) ? convertedClimb[0] : null, icon: howMuchClimb, units: convertedClimb[1]}}
            data1={{value: convertHeight(vario.total, units)[0], units: units ? t('units.ft') : t('units.m'), icon: vario?.average >= 0 ? faCloudUpload : faCloudArrowDown}}
            data2={{value: vario.Xperiod, units: t('units.sec'), icon: faHourglassHalf}}
        />
    ) : (
        <SummaryComponent
            id="climb"
            title={t('pilot_metric.vario')} //
            main={{value: null, icon: faSignal, units: ''}}
        />
    );
}

function WindComponent({wind}: {wind: {speed: number; direction: number} | undefined}) {
    const {t} = useTranslation('common');
    if (!wind?.speed) return null;
    return (
        <SummaryComponent
            id="wind"
            title={t('pilot_metric.wind')} //
            main={{value: wind.speed, units: t('units.kph'), icon: faWind, description: t('pilot_metric.recent_wind_speed')}}
            data1={{value: wind.direction, units: '°', icon: faLocationArrow, description: t('pilot_metric.wind_bearing'), iconStyle: {transform: `rotate(${wind.direction + 135}deg)`}}}
        />
    );
}

function StartComponent({
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
    const {t} = useTranslation('common');
    const [endTime, description, icon] = utcFinish
        ? [OptionalTime(' ', utcFinish, tz), t('pilot_metric.finish_time'), faHourglassEnd] //
        : taskTimeRemaining
          ? [OptionalDuration('', taskTimeRemaining), t('pilot_metric.remaining_time'), faHistory]
          : ['', t('pilot_metric.finish_time'), null];

    const duration = OptionalDuration('+', taskDuration as Epoch).split(':');

    return (
        <SummaryComponent
            id="times"
            title={t('pilot_metric.times')} //
            width="120px"
            main={{value: duration[0] ? duration[0] + ':' + duration[1] : null, units: ':' + duration[2], icon: faStopwatch, description: t('pilot_metric.elapsed_time')}}
            data1={{value: OptionalTime('', utcStart, tz), icon: faHourglassStart, description: t('pilot_metric.start_time')}}
            data2={{value: endTime, icon, description: description}}
        />
    );
}

function HandicappedSpeedComponent({
    utcFinish,
    handicappedTaskSpeed,
    actualTaskSpeed
}: //
{
    utcFinish: Epoch;
    handicappedTaskSpeed: number;
    actualTaskSpeed: number;
}) {
    const {t} = useTranslation('common');
    return (
        <SummaryComponent
            id="speed"
            title={t('pilot_metric.speed')} //
            main={{value: handicappedTaskSpeed, units: t('units.kph'), icon: utcFinish ? faTrophy : faPaperPlane, description: t('pilot_metric.handicapped_speed')}}
            data1={{value: actualTaskSpeed, units: t('units.kph'), icon: faTachometerAlt, description: t('pilot_metric.actual_speed')}}
        />
    );
}

function ActualSpeedComponent({
    utcFinish,
    actualTaskSpeed
}: //
{
    utcFinish: Epoch;
    actualTaskSpeed: number;
}) {
    const {t} = useTranslation('common');
    return (
        <SummaryComponent
            width="100px"
            id="speed"
            title={t('pilot_metric.speed')} //
            main={{value: actualTaskSpeed, units: t('units.kph'), icon: utcFinish ? faTrophy : faPaperPlane, description: t('pilot_metric.actual_speed')}}
        />
    );
}

function HandicappedDistanceComponent({score}: {score: PilotScore}) {
    const {t} = useTranslation('common');
    return (
        <SummaryComponent
            width="90px"
            id="hdistance"
            title={t('pilot_metric.distance')} //
            main={{value: score.handicapped.taskDistance, units: t('units.km'), icon: score.utcFinish ? faTrophy : faPaperPlane, description: t('pilot_metric.handicapped_distance')}}
            data1={{value: score.actual.taskDistance, units: t('units.km'), icon: faRightFromBracket, description: t('pilot_metric.actual_distance')}}
            data2={{
                value: !score.utcFinish ? (score.handicapped.distanceRemaining ?? score.handicapped.minPossible) : undefined,
                units: t('units.km'),
                icon: faRightToBracket,
                description: t('pilot_metric.handicapped_distance_remaining')
            }}
        />
    );
}

function ActualDistanceComponent({score}: {score: PilotScore}) {
    const {t} = useTranslation('common');
    return (
        <SummaryComponent
            width="90px"
            id="distance"
            title={t('pilot_metric.distance')} //
            main={{value: score.actual.taskDistance, units: t('units.km'), icon: score.utcFinish ? faTrophy : faPaperPlane, description: t('pilot_metric.actual_distance')}}
            data1={{value: !score.utcFinish ? (score.actual.distanceRemaining ?? score.actual.minPossible) : undefined, units: t('units.km'), icon: faRightToBracket, description: t('pilot_metric.actual_distance_remaining')}}
        />
    );
}

function grBattery(gr: number): any {
    if (gr > 100) {
        return faBatteryQuarter;
    } else if (gr > 75) {
        return faBatteryHalf;
    } else if (gr > 40) {
        return faBatteryThreeQuarters;
    } else if (gr > 1) {
        return faBatteryFull;
    }
    return faBatteryEmpty;
}

function HandicappedGRComponent({handicappedGrRemaining, actualGrRemaining}: {handicappedGrRemaining: number; actualGrRemaining: number}) {
    const {t} = useTranslation('common');
    return (
        <SummaryComponent
            width="100px"
            id="hgr"
            title={t('pilot_metric.ld')} //
            main={{value: handicappedGrRemaining < 999 ? handicappedGrRemaining : '∞', units: ' ' + t('units.ratio'), icon: grBattery(handicappedGrRemaining), description: t('pilot_metric.handicapped_ld_remaining')}}
            data1={{value: actualGrRemaining < 999 ? actualGrRemaining : '∞', units: t('units.ratio'), icon: grBattery(actualGrRemaining), description: t('pilot_metric.actual_ld_remaining')}}
        />
    );
}

function ActualGRComponent({actualGrRemaining, homeGr}: {actualGrRemaining: number; homeGr: number}) {
    const {t} = useTranslation('common');
    return (
        <SummaryComponent
            width="100px"
            id="gr"
            title={t('pilot_metric.ld')} //
            main={{value: actualGrRemaining < 999 ? actualGrRemaining : '∞', units: t('units.ratio'), icon: grBattery(actualGrRemaining), description: t('pilot_metric.actual_ld_remaining')}}
            data1={{value: homeGr < 999 ? homeGr : '∞', units: t('units.ratio'), icon: faHome, description: t('pilot_metric.ld_to_home')}}
        />
    );
}

export const Details = ({
    compno,
    pilot,
    units,
    tz,
    replayTime,
    onEditHandicap,
    officialDelay = 0
}: {
    compno: Compno;
    pilot: API_ClassName_Pilots_PilotDetail;
    tz: TZ;
    units: Units;
    replayTime: Epoch | undefined;
    onEditHandicap?: (compno: Compno, handicap: number) => void;
    officialDelay?: number;
}) => {
    const {t} = useTranslation('common');
    let competitionDelay = useMemo(() => {
        if (officialDelay > 10) {
            return (
                <a href="#" title={t('pilot.view_delayed_official')} className="tooltipicon">
                    <span style={{color: 'grey'}}>
                        &nbsp;+&nbsp;
                        <FontAwesomeIcon icon={faClockRotateLeft} size="sm" />
                        &nbsp;{OptionalDurationMM('', officialDelay as Epoch, 'm')}
                    </span>
                </a>
            );
        }
        return null;
    }, [t, officialDelay]);

    // Get vario for specific time
    const vario = useSelector((state) => selectPilotVario(state, compno, replayTime));
    const score = useSelector((state) => selectPilotScore(state, compno, replayTime));
    const latestUpdate = useSelector(selectLatestUpdate);

    if (!pilot) {
        return null;
    }

    const hasHandicappedResults = !!score?.handicapped;

    // Blocked pilots get a synthesised score with flightStatus only — no actual/
    // handicapped sub-messages — so gate these on score?.actual rather than just
    // score, otherwise score.actual.taskSpeed throws during render.
    const speed = score?.actual ? ( //
        hasHandicappedResults ? (
            <HandicappedSpeedComponent utcFinish={score.utcFinish as Epoch} handicappedTaskSpeed={score.handicapped.taskSpeed} actualTaskSpeed={score.actual.taskSpeed} />
        ) : (
            <ActualSpeedComponent utcFinish={score.utcFinish as Epoch} actualTaskSpeed={score.actual.taskSpeed} />
        )
    ) : null;

    const distance = score?.actual ? hasHandicappedResults ? <HandicappedDistanceComponent score={score} /> : <ActualDistanceComponent score={score} /> : null;
    const gr = score?.actual ? ( //
        hasHandicappedResults ? (
            <HandicappedGRComponent handicappedGrRemaining={score.handicapped.grRemaining} actualGrRemaining={score.actual.grRemaining} />
        ) : (
            <ActualGRComponent actualGrRemaining={score.actual.grRemaining} homeGr={score.home?.grRemaining} />
        )
    ) : null;
    const wind = score?.wind ? <WindComponent wind={score.wind} /> : null;

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

    // Check at render if we are up to date or not, delay calculated in sorting which
    // gets updated regularily
    const delay = (replayTime ?? latestUpdate ?? Infinity) - (vario?.t || 0);
    const uptodate = delay < 45;
    const old =
        delay > offlineTime &&
        score &&
        score.flightStatus != PositionStatus.Home &&
        score.flightStatus != PositionStatus.Finished &&
        score.flightStatus != PositionStatus.Landed &&
        score.flightStatus != PositionStatus.Blocked;

    // Figure out what to show based on the db status
    let flightDetails = null;
    const statusClassName = old ? 'status old' : 'status';

    // Simplify displaying units
    const altitude = vario?.altitude ? (
        <span style={{float: 'right', paddingTop: '3px'}}>
            {old ? (
                <>
                    <FontAwesomeIcon icon={faSignal} />{' '}
                </>
            ) : null}
            {t('pilot.altitude_with_agl', {altitude: displayHeight(vario.altitude, units), agl: displayHeight(vario.agl, units)})}
        </span>
    ) : null;

    const trackingBlocked = score?.flightStatus == PositionStatus.Blocked;
    if (trackingBlocked) {
        // Pilot is identified but Permit-Livetracking is declined in
        // the DDB or FlarmNet. Show an explanatory note — no positions
        // ever arrive for them.
        flightDetails = <div>{t('pilot.tracking_declined', {defaultValue: "Live tracking blocked — this glider's tracker is set to decline live tracking in the OGN DDB or FlarmNet"})}</div>;
    } else if ((!score || score.flightStatus == PositionStatus.Unknown) && !vario) {
        flightDetails = <></>;
    } else if (!score?.utcStart) {
        if (score?.flightStatus == PositionStatus.Grid) {
            flightDetails = <div>{t('pilot.gridded_waiting')}</div>;
        } else {
            flightDetails = (
                <div>
                    {t('pilot.no_start')}
                    <ul className={statusClassName}>
                        <ClimbComponent vario={vario} units={!!units} />
                    </ul>
                </div>
            );
        }
    } else if (score?.utcFinish) {
        flightDetails = (
            <>
                <ul className={statusClassName}>
                    {speed}
                    {score?.taskTimeRemaining ? distance : null}
                    {times}
                </ul>
                <FlightLegs score={score} tz={tz} units={!!units} />
            </>
        );
    } else {
        if (score?.flightStatus == PositionStatus.Landed) {
            flightDetails = (
                <div>
                    {t('pilot.landed_out')}
                    <ul className={statusClassName}>{distance}</ul>
                    <FlightLegs score={score} tz={tz} units={!!units} />
                </div>
            );
        } else if (score?.flightStatus == PositionStatus.Home) {
            flightDetails = (
                <div>
                    {t('pilot.landed_back')}
                    <ul className={statusClassName}>{distance}</ul>
                    <FlightLegs score={score} tz={tz} units={!!units} />
                </div>
            );
        } else {
            flightDetails = (
                <>
                    <ul className={statusClassName}>
                        <ClimbComponent vario={vario} units={!!units} />
                        {speed}
                        {distance}
                        {times}
                        {gr}
                        {wind}
                    </ul>
                    <FlightLegs score={score} tz={tz} units={!!units} />
                </>
            );
        }
    }

    // Are we in coverage or not, keyed off uptodate
    const ognCoverage = score?.utcFinish ? (
        t('pilot.finished') //
    ) : replayTime ? (
        <span>
            &nbsp;
            <FontAwesomeIcon icon={faBackward} />
            &nbsp;
            {OptionalTime('', replayTime, tz)}
            {process.env.NODE_ENV == 'development' && score ? OptionalTime(',', score?.t ?? 0, tz) + ' ' + (score?.live ? 'live' : 'rebuilt') : null}
            {process.env.NODE_ENV == 'development' ? (
                <p>
                    t:{latestUpdate} s:{score?.t}
                </p>
            ) : null}
        </span>
    ) : uptodate ? (
        <span>
            &nbsp;
            <a href="#" style={{color: 'black'}} title={t('pilot.view_in_coverage')} className="tooltipicon">
                <FontAwesomeIcon icon={faSquareCheck} /> {t('pilot.view_delay', {seconds: Math.round(delay)})}
                {process.env.NODE_ENV == 'development' && score ? ', ' + Math.round(latestUpdate - score?.t) + 's delay' + OptionalTime(', ', score?.t ?? 0, tz) + ' ' + (score?.live ? 'live' : 'rebuilt') : null}
                {process.env.NODE_ENV == 'development' ? (
                    <p>
                        t:{latestUpdate} s:{score?.t}
                    </p>
                ) : null}
            </a>
        </span>
    ) : (
        <span>
            &nbsp;
            <a href="#" style={{color: 'grey'}} title={t('pilot.view_no_recent')} className="tooltipicon">
                {(delay || Infinity) < 3600 ? (
                    <>
                        <FontAwesomeIcon icon={faSpinner} spin />
                        &nbsp; {t('pilot.view_last_point', {delay: delayToText(delay)})}
                    </>
                ) : (
                    <>
                        <FontAwesomeIcon icon={faTriangleExclamation} />
                        &nbsp;
                        {vario ? <>{t('pilot.view_old')}</> : <>{t('pilot.view_no_signal')}</>}
                    </>
                )}
                {process.env.NODE_ENV == 'development' && score ? ', ' + delayToText(latestUpdate - score?.t) + OptionalTime(', ', score?.t ?? 0, tz) + ' ' + (score?.live ? 'live' : 'rebuilt') : null}
                {process.env.NODE_ENV == 'development' ? (
                    <p>
                        t:{latestUpdate} s:{score?.t}
                    </p>
                ) : null}
            </a>
        </span>
    );

    const flag =
        (pilot.country || '') !== '' ? (
            <div className="details-flag">
                <a href="#" title={new Intl.DisplayNames([], {type: 'region'})?.of(pilot.country) || t('pilot.country_fallback', {country: pilot.country})} className="tooltipicon">
                    {isoCountryCodeToFlagEmoji(pilot.country)}
                </a>
            </div>
        ) : null;

    const className = uptodate ? 'details' : 'details old';

    return (
        <div className="pilotdetails">
            {flag}
            <h6 style={{width: '100%'}}>
                {pilot.compno}
                {trackingBlocked ? null : (
                    <>
                        :<b>{pilot.name}</b>
                    </>
                )}
                <span style={{float: 'right', paddingRight: '0.5em'}}>
                    {pilot.gliderType.substring(0, 20)}
                    {pilot.handicap !== 100 ? ` (${pilot.handicap})` : ''}
                    {onEditHandicap ? (
                        <FontAwesomeIcon
                            icon={faPenToSquare}
                            size="xs"
                            style={{cursor: 'pointer', marginLeft: 4, opacity: 0.6}}
                            onClick={() => {
                                const value = window.prompt(t('pilot.edit_handicap_prompt'), pilot.handicap !== 100 ? String(pilot.handicap) : '');
                                if (value === null) return;
                                if (value.trim() === '') {
                                    onEditHandicap(compno, 100);
                                } else {
                                    const h = parseFloat(value);
                                    if (!isNaN(h) && h > 0) {
                                        onEditHandicap(compno, h);
                                    }
                                }
                            }}
                            title={t('pilot.edit_handicap')}
                        />
                    ) : null}
                </span>
                <br />
                <span className="largeScreen">{pilot.country ? new Intl.DisplayNames([], {type: 'region'})?.of(pilot.country) : ''}</span>
                <br className="largeScreen" />
                <span style={{fontSize: '80%'}}>
                    {ognCoverage}
                    {uptodate || vario ? competitionDelay : null}
                    <span>{altitude}</span>
                </span>
            </h6>
            {flightDetails}
        </div>
    );
};

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
    if (!displayIcon) {
        return null;
    }
    // If it's very delayed and we have had a point and
    // we are in the right mode then display a spinner
    if (displayIcon == 'nosignal') {
        return (
            <span className="pilotstatus">
                <FontAwesomeIcon icon={faSpinner} spin={true} />
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
// Pair / team names ("John & Jack", "Anna and Beth") get collapsed to
// initials ("J & J") so they fit in the narrow horizontal strip caption.
function shortenPairName(name?: string): string {
    if (!name) return '';
    const parts = name.split(/\s*(?:&|\sand\s)\s*/i);
    if (parts.length < 2) return name;
    return parts
        .map((p) => p.trim()[0])
        .filter(Boolean)
        .join(' & ');
}

const Pilot = memo(function Pilot({
    pilot,
    compno,
    value,
    suffix,
    icon,
    selected,
    blocked,
    vertical,
    position,
    onClick,
    setHoveredCompno
}: //
{
    pilot: API_ClassName_Pilots_PilotDetail;
    compno: Compno;
    value: string | number;
    suffix?: string;
    icon: any;
    selected: boolean;
    blocked?: boolean;
    vertical?: boolean;
    position?: number;
    onClick: any;
    setHoveredCompno?: (compno: Compno | null) => void;
}) {
    const onMouseEnter = setHoveredCompno ? () => setHoveredCompno(compno) : undefined;
    const onMouseLeave = setHoveredCompno ? () => setHoveredCompno(null) : undefined;

    // Pilots whose tracker is blocked (DDB / FlarmNet Permit-Livetracking
    // declined) are surfaced without their name to respect the opt-out.
    const linkTitle = blocked ? compno : compno + ': ' + pilot?.name;
    if (vertical) {
        const className = selected ? 'pilot-row pilothovercapture selected' : 'pilot-row pilothovercapture';
        return (
            <li className={className} key={compno} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
                <a href="#" title={linkTitle} onClick={() => onClick(compno)}>
                    <span className="pilot-row-left">
                        <span className="pilot-row-position">{position != null ? `${position}.` : ''}</span>
                        <span className="pilot-row-flag">{pilot?.country ? isoCountryCodeToFlagEmoji(pilot.country) : ''}</span>
                        <span className="pilot-row-compno">{compno}</span>
                        {blocked ? null : <span className="pilot-row-name">{pilot?.name}</span>}
                    </span>
                    <span className="pilot-row-right">
                        <span className="data">{(value || '-').toString()}</span>
                        {suffix ? <span className="units">{suffix}</span> : null}
                        <PilotStatusIcon displayIcon={icon} />
                    </span>
                </a>
            </li>
        );
    }

    const className = selected ? 'small-pic pilot pilot-strip pilothovercapture selected' : 'small-pic pilot pilot-strip pilothovercapture';
    const displayName = blocked ? '' : shortenPairName(pilot?.name);

    return (
        <li className={className} key={compno} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
            <a href="#" title={linkTitle} onClick={() => onClick(compno)}>
                <div className="pilot-strip-compno">
                    {pilot?.country ? <span className="pilot-strip-flag">{isoCountryCodeToFlagEmoji(pilot.country)}</span> : null}
                    <span className="pilot-strip-compno-text">{compno}</span>
                </div>
                <div>
                    <div className="caption">
                        <span className="pilot-strip-name">{displayName}</span>
                        <PilotStatusIcon displayIcon={icon} />
                    </div>
                    <div>
                        <div className="data">{(value || '-').toString()}</div>
                        <div className="units">{suffix ?? null}</div>
                    </div>
                </div>
            </a>
        </li>
    );
});
//
// Render the list of pilots
export const PilotList = memo(function PilotList({
    pilots,
    selectedPilot,
    setSelectedCompno,
    setHoveredCompno,
    options,
    sortOrder,
    now,
    tz,
    horizontal,
    vertical
}: //
{
    pilots: API_ClassName_Pilots;
    selectedPilot: Compno;
    setSelectedCompno: Function;
    setHoveredCompno?: (compno: Compno | null) => void;
    options: Options;
    live: boolean;
    sortOrder: string;
    now: Epoch | undefined;
    tz: TZ;
    horizontal?: boolean;
    vertical?: boolean;
}) {
    // ensure they sort keys are correct for each pilot, we don't actually
    // want to change the loaded pilots file, just the order they are presented
    // this can be done with a clone and reoder
    const pilotList: AllNormalDisplayKeys = useSelector(
        (state) =>
            (sortOrders[sortOrder] ?? sortOrders['auto'])(state, now)
                .map((r) => (r.converter ? r.converter(r, options.units, tz) : r))
                .sort((a, b) => b.sortKey - a.sortKey),
        sortKeyEqualityCheck
    );

    const pilotStatus = useSelector((state) => selectAllStatus(state, now));

    const onClick = useCallback(
        (compno: Compno) => {
            selectedPilot === compno ? setSelectedCompno(null) : setSelectedCompno(compno);
        },
        [selectedPilot]
    );

    // Generate the pilot list, sorted by the correct key
    const pilotComponents = pilotList.map((pilot, idx) => {
        const status = pilotStatus?.[pilot.compno]?.status ?? 0;
        return (
            <Pilot //
                key={pilot.compno}
                {...pilot}
                pilot={pilots[pilot.compno]}
                icon={icons[status]}
                blocked={status === PositionStatus.Blocked}
                selected={selectedPilot === pilot.compno}
                vertical={vertical}
                position={idx + 1}
                onClick={onClick}
                setHoveredCompno={setHoveredCompno}
            />
        );
    });

    // With a single pilot there's nothing to sort or choose between, so
    // suppress the whole list (ognfeed auto-selects that pilot via a
    // derived `effectiveSelectedCompno`, so the footer details pane
    // still surfaces them).
    if (!pilotList?.length || pilotList.length <= 1) {
        return null;
    }

    const listClass = horizontal ? 'pilots pilots-horizontal' : vertical ? 'pilots pilots-vertical' : 'pilots';
    return <ul className={listClass}>{pilotComponents}</ul>;
});
