//
// The turnpoint list
//
import {memo, useMemo} from 'react';
import {useTranslation} from 'next-i18next/pages';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';

import {faMagnifyingGlassLocation, faCaretUp, faCaretDown} from '@fortawesome/free-solid-svg-icons';

import {useState} from 'react';
import {Spinner} from './loaders';

const matchWords = /(^\w{1}|\.\s*\w{1})/gi;

import {selectTask, selectHasTask} from '../redux/taskSlice';
import {selectCompByCompid} from '../redux/competitionsSlice';
import {selectNow} from '../redux/nowSlice';
import {useSelector} from '../redux';

import type {TaskLeg, ClassName, TZ, Epoch} from '../types';
import {fromDateCode} from '../datecode';
import {getNow} from '../now';

//
export const TaskDetails = memo(function TaskDetails({
    compid,
    vc,
    fitBounds,
    zoomToTurnpoint,
    tz,
    replayTime,
    defaultOpen
}: {
    compid: string;
    vc: ClassName;
    fitBounds: Function;
    zoomToTurnpoint?: (lat: number, lng: number, radius?: number) => void;
    tz: TZ;
    replayTime: Epoch;
    defaultOpen?: boolean;
}) {
    const {t} = useTranslation('common');
    const task = useSelector((state) => selectTask(state, vc));
    const hasTask = useSelector((state) => selectHasTask(state, vc));
    const compByCompid = useMemo(() => selectCompByCompid(compid), [compid]);
    const summary = useSelector(compByCompid);
    const [open, setOpen] = useState(!!defaultOpen);

    const lang = navigator.languages != undefined ? navigator.languages[0] : navigator.language;
    // `summary` is null until the /all snapshot lands; guard the lookup.
    const fClass = summary?.classes?.find((c) => c.class == vc);
    const dateString = useMemo(() => {
        const date = (task?.details?.calendardate ?? fClass?.datecode) ? fromDateCode(fClass.datecode) : null;
        return date ? `${new Date(date).toLocaleDateString(lang, {day: 'numeric', month: 'short'})}` : '';
    }, [lang, tz, task?.details?.calendardate]);

    const noStart = useMemo(() => {
        return (task?.rules?.nostartutc ?? 0) > (replayTime ?? getNow())
            ? t('task.start_opens_at', {time: new Date(task.rules.nostartutc * 1000).toLocaleTimeString(lang, {timeZone: tz, hour: '2-digit', minute: '2-digit'})})
            : '';
    }, [lang, tz, task?.rules?.nostartutc, t]);

    // Before 10:00 local-comp-time the daemon is still serving yesterday's
    // tracks (the daily flip happens at 10:00 local). Surface a note while
    // viewing live so users don't think the date is wrong.
    const liveNow = useSelector(selectNow);
    const showPreviousDayNote = useMemo(() => {
        if (replayTime) return false;
        const ms = (liveNow ? liveNow * 1000 : Date.now());
        const hourStr = new Intl.DateTimeFormat('en-GB', {timeZone: tz, hour: '2-digit', hourCycle: 'h23'}).format(new Date(ms));
        return parseInt(hourStr, 10) < 10;
    }, [tz, replayTime, liveNow]);

    if (!summary || !hasTask) {
        return <Spinner />;
    }

    if (!fClass || !task) {
        return (
            <>
                <h5>{dateString}: {t('task.no_task_configured')}</h5>
                {showPreviousDayNote ? <p className="task-previous-day-note">{t('task.previous_day_note')}</p> : null}
            </>
        );
    }

    let taskDescription: any = '';
    switch (task.details.type) {
        case 'S':
            taskDescription = t('task.speed_with_distance', {distance: task.details.distance});
            break;
        case 'D':
            taskDescription = t('task.distance_handicap_with_distance', {distance: task.details.distance});
            break;
        case 'E':
            taskDescription = t('task.e3_distance_handicap_with_distance', {distance: task.details.distance});
            break;
        case 'A':
            if (task.details.duration.substring(1, 5) == '0:00') {
                taskDescription = t('task.aat_short');
            } else {
                taskDescription = t('task.aat_with_duration', {duration: task.details.duration.substring(1, 5)});
            }
            break;
    }

    if (task.details.status == 'Z') {
        taskDescription = t('task.scrubbed');
    }

    const classNameSentenceCased = fClass.classname.replace(matchWords, (r) => r.toUpperCase());

    return (
        <div>
            <h5 className="task-heading">
                <button title={t('task.zoom_to_task')} onClick={fitBounds as any}>
                    <FontAwesomeIcon icon={faMagnifyingGlassLocation} />
                </button>
                <span className="task-title">
                    {dateString}: {taskDescription}
                </span>
                <button onClick={() => setOpen(!open)} title={open ? t('task.hide_details') : t('task.show_details')} aria-controls="task-collapse" aria-expanded={open}>
                    <FontAwesomeIcon icon={open ? faCaretUp : faCaretDown} />
                </button>
            </h5>
            {showPreviousDayNote ? <p className="task-previous-day-note">{t('task.previous_day_note')}</p> : null}
            {task?.rules?.nostartutc ? <>{noStart}</> : null}
            {open ? (
                <div id="task-collapse">
                    <p>{task?.details?.nostart != '00:00:00' ? t('task.start_open', {time: task.details.nostart.substring(0, 5)}) : ''}</p>
                    <Tasklegs legs={task.legs} onSelect={zoomToTurnpoint} />

                    {task.details.info && (
                        <>
                            <hr />
                            <div>{task.details.info}</div>
                        </>
                    )}
                </div>
            ) : null}
        </div>
    );
});

// Internal: details on the leg
function Tasklegs({legs, onSelect}: {legs: TaskLeg[]; onSelect?: (lat: number, lng: number, radius?: number) => void}) {
    const {t} = useTranslation('common');
    return (
        <ul className="task-legs">
            <li className="task-legs-head" aria-hidden="true">
                <span className="task-leg-num">#</span>
                <span className="task-leg-tp-header">{t('task.turnpoint')}</span>
                <span className="task-leg-bearing">{t('task.bearing')}</span>
                <span className="task-leg-length">{t('task.leg_length')}</span>
                <span className="task-leg-radius">{t('task.tp_radius')}</span>
            </li>
            {legs.map((leg) => {
                const onClick = onSelect ? () => onSelect(leg.nlat, leg.nlng, leg.r1) : undefined;
                return (
                    <li key={leg.legno} className="task-leg-row">
                        <a
                            href="#"
                            title={`${leg.legno}: ${leg.ntrigraph} — ${leg.name}`}
                            onClick={(e) => {
                                e.preventDefault();
                                onClick?.();
                            }}
                        >
                            <span className="task-leg-num">{leg.legno}.</span>
                            <span className="task-leg-tri">{leg.ntrigraph}</span>
                            <span className="task-leg-name">{leg.name}</span>
                            <span className="task-leg-bearing">{leg.legno !== 0 ? `${leg.bearing}°` : ''}</span>
                            <span className="task-leg-length">{leg.legno !== 0 ? `${Math.round(leg.length * 10) / 10} km` : ''}</span>
                            <span className="task-leg-radius">{leg.r1 !== 0 ? `${Math.round(leg.r1 * 10) / 10} km` : ''}</span>
                        </a>
                    </li>
                );
            })}
        </ul>
    );
}
