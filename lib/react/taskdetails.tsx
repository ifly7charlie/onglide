//
// The turnpoint list
//
import {memo} from 'react';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {solid, regular} from '@fortawesome/fontawesome-svg-core/import.macro';

import {useState} from 'react';
import {useTask, Spinner, Error} from './loaders';

import Collapse from 'react-bootstrap/Collapse';

const matchWords = /(^\w{1}|\.\s*\w{1})/gi;

//
export const TaskDetails = memo(function TaskDetails({vc, fitBounds}: {vc: any; fitBounds: Function}) {
    const {data, isLoading, isError} = useTask(vc);
    const [open, setOpen] = useState(false);

    if (isLoading) return <Spinner />;
    if (isError) return <Error />;

    if (!data || !data.contestday) {
        return (
            <>
                <br style={{clear: 'both'}} />
                <br style={{clear: 'both'}} />
                <h4>No task</h4>
            </>
        );
    }
    const fClass = data.contestday.class;
    let taskDescription: any = '';
    switch (data.task.type) {
        case 'S':
            taskDescription = <>Speed Task: {data.task.distance}km</>;
            break;
        case 'D':
            taskDescription = <>Distance Handicap Task: {data.task.distance}km</>;
            break;
        case 'E':
            taskDescription = <>e3Glide Distance Handicap Task: {data.task.distance}km</>;
            break;
        case 'A':
            if (data.task.duration.substring(1, 5) == '0:00') {
                taskDescription = <>Assigned Area Task</>;
            } else {
                taskDescription = <>Assigned Area Task: {data.task.duration.substring(1, 5)} hours</>;
            }
            break;
    }

    if (data.contestday.status == 'Z') {
        taskDescription = 'Scrubbed';
    }

    const classNameSentenceCased = data.classes.classname.replace(matchWords, (r) => r.toUpperCase());

    return (
        <>
            <div className={'d-lg-inline d-none'}>
                <h5 style={{fontSize: '1.2vw'}}>
                    {classNameSentenceCased} {taskDescription}
                    <span className="sorting" style={{fontSize: 'medium'}}>
                        <button title="Zoom to task" onClick={fitBounds as any}>
                            <FontAwesomeIcon icon={solid('magnifying-glass-location')} />
                        </button>
                        &nbsp;
                        <button className="d-lg-inline d-none" onClick={() => setOpen(!open)} title={open ? 'Hide Task Details' : 'Show Task Details'} aria-controls="task-collapse" aria-expanded={open}>
                            <FontAwesomeIcon icon={solid('tasks')} size="sm" />
                            <FontAwesomeIcon icon={open ? solid('caret-up') : solid('caret-down')} size="sm" />
                        </button>
                    </span>
                </h5>

                <Collapse in={open}>
                    <div id="task-collapse">
                        <h5>{data.classes.classname}</h5>
                        <p>{data.contestday.displaydate}</p>
                        <Tasklegs legs={data.legs} />

                        {data.contestday.notes?.length > 0 && (
                            <>
                                <hr />
                                <div>{data.contestday.notes}</div>
                            </>
                        )}
                    </div>
                </Collapse>
                <hr />
            </div>
        </>
    );
});

// Internal: details on the leg
function Tasklegs(props) {
    return (
        <table className="table table-condensed" style={{marginBottom: '0px'}}>
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
                        <td>{leg.nname}</td>
                        <td>{leg.legno !== 0 ? leg.bearing + '° ' : ''}</td>
                        <td>{leg.legno !== 0 ? Math.round(leg.length * 10) / 10 + ' km' : ''}</td>
                        <td>{leg.r1 !== 0 ? Math.round(leg.r1 * 10) / 10 + ' km' : ''}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
