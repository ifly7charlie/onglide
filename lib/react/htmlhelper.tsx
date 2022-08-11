//
// Some helpers for rending assistance
//
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';

export function Nbsp() {
    return <>&nbsp;</>;
}

export function TooltipIcon(props) {
    return (
        <a href="#" title={props.tooltip} className="tooltipicon">
            <FontAwesomeIcon {...props} />
        </a>
    );
}
/*
export function Icon(props) {
    const size = props.size ? props.size : '';

    const inner = () => {
        if (props.spin == true) {
            return <i className={`icon-${props.type} ${size} icon-spin`} />;
        }

        if (props.typeinverted) {
            return (
                <span className="icon-stack">
                    <i className={`icon-${props.base} icon-stack-base`} />
                    <i className={`icon-${props.typeinverted} icon-light`} />
                </span>
            );
        }

        if (props.base) {
            return (
                <span className="icon-stack">
                    <i className={`icon-${props.base} ${size} icon-stack-base}`} />
                    <i className={`icon-${props.type} ${size}`} />
                </span>
            );
        }

        return <FontAwesomeIcon icon={`fa-solid fa-${props.type}`} />;
    };
    if (props.tooltip) {
        return (
            <a href="#" title={props.tooltip} className="tooltipicon">
                {inner()}
            </a>
        );
    } else {
        return inner();
    }
}
*/
