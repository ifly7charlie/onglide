//
// The turnpoint list
//
import {memo, useMemo} from 'react';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';

import {faMagnifyingGlassLocation, faCaretUp, faCaretDown} from '@fortawesome/free-solid-svg-icons';

import {useState} from 'react';
import {useContest, Spinner, Error} from './loaders';

const matchWords = /(^\w{1}|\.\s*\w{1})/gi;

import {selectTask, selectHasTask} from '../redux/taskSlice';
import {useSelector} from '../redux';

import type {TaskLeg, ClassName, TZ, Epoch} from '../types';
import {fromDateCode} from '../datecode';
import {getNow} from '../now';

//
export const TaskDetails = memo(function TaskDetails({compid, vc, fitBounds, tz, replayTime, defaultOpen}: {compid: string; vc: ClassName; fitBounds: Function; tz: TZ; replayTime: Epoch; defaultOpen?: boolean}) {
    const task = useSelector((state) => selectTask(state, vc));
    const hasTask = useSelector((state) => selectHasTask(state, vc));
    const {comp, isLoading} = useContest(compid);
    const [open, setOpen] = useState(!!defaultOpen);

    const lang = navigator.languages != undefined ? navigator.languages[0] : navigator.language;
    // And then produce a string to display it locally. `comp` is undefined
    // until useContest() resolves, so guard the lookup — the early return
    // below handles the unresolved case.
    const fClass = comp?.classes?.find((c: any) => c.class == vc);
    const dateString = useMemo(() => {
        const date = (task?.details?.calendardate ?? fClass?.datecode) ? fromDateCode(fClass.datecode) : null;
        return date ? `${new Date(date).toLocaleDateString(lang, {day: 'numeric', month: 'short'})}` : '';
    }, [lang, tz, task?.details?.calendardate]);

    const noStart = useMemo(() => {
        console.log('noStart:', getNow(), task?.rules?.nostartutc);
        return (task?.rules?.nostartutc ?? 0) > (replayTime ?? getNow()) ? `Start Opens at ${new Date(task.rules.nostartutc * 1000).toLocaleTimeString(lang, {timeZone: tz, hour: '2-digit', minute: '2-digit'})}` : '';
    }, [lang, tz, task?.rules?.nostartutc]);

    if (isLoading || !hasTask) {
        return <Spinner />;
    }

    if (!comp || !fClass || !task) {
        return (
            <>
                <h5>{dateString}: No task Configured</h5>
            </>
        );
    }

    let taskDescription: any = '';
    console.log('TD:', task.details);
    switch (task.details.type) {
        case 'S':
            taskDescription = <>{task.details.distance}km Speed Task</>;
            break;
        case 'D':
            taskDescription = <>Distance Handicap Task: {task.details.distance}km</>;
            break;
        case 'E':
            taskDescription = <>e3Glide Distance Handicap Task: {task.details.distance}km</>;
            break;
        case 'A':
            if (task.details.duration.substring(1, 5) == '0:00') {
                taskDescription = <>Assigned Area</>;
            } else {
                taskDescription = <>{task.details.duration.substring(1, 5)} hour Assigned Area Task</>;
            }
            break;
    }

    if (task.details.status == 'Z') {
        taskDescription = 'Scrubbed';
    }

    const classNameSentenceCased = fClass.classname.replace(matchWords, (r) => r.toUpperCase());

    return (
        <div>
            <h5 className="task-heading">
                <button title="Zoom to task" onClick={fitBounds as any}>
                    <FontAwesomeIcon icon={faMagnifyingGlassLocation} />
                </button>
                <span className="task-title">
                    {dateString}: {taskDescription}
                </span>
                <button onClick={() => setOpen(!open)} title={open ? 'Hide Task Details' : 'Show Task Details'} aria-controls="task-collapse" aria-expanded={open}>
                    <FontAwesomeIcon icon={open ? faCaretUp : faCaretDown} />
                </button>
            </h5>
            {task?.rules?.nostartutc ? <>{noStart}</> : null}
            {open ? (
                <div id="task-collapse">
                    <p>{task?.details?.nostart != '00:00:00' ? `Start open ${task.details.nostart.substring(0, 5)}` : ''}</p>
                    <Tasklegs legs={task.legs} />

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
function Tasklegs(props: {legs: TaskLeg[]}) {
    return (
        <table className="legs-mini" style={{marginBottom: '0px'}}>
            <thead>
                <tr>
                    <td colSpan={2}>Turnpoint</td>
                    <td>Bearing</td>
                    <td>Leg Length</td>
                    <td>TP Radius</td>
                </tr>
            </thead>
            <tbody>
                {props.legs.map((leg) => (
                    <tr key={leg.legno}>
                        <td>
                            {leg.legno}:{leg.ntrigraph}
                        </td>
                        <td>{leg.name}</td>
                        <td>{leg.legno !== 0 ? leg.bearing + '° ' : ''}</td>
                        <td>{leg.legno !== 0 ? Math.round(leg.length * 10) / 10 + ' km' : ''}</td>
                        <td>{leg.r1 !== 0 ? Math.round(leg.r1 * 10) / 10 + ' km' : ''}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
