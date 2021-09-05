//
// Some helpers for rending assistance
//


export function Nbsp () {
    return <>&nbsp;</>;
}

export function Icon (props) {
    const size = props.size?props.size:'';

	const inner = () => {
		if( props.spin == true ) {
			return (
				<i className={`icon-${props.type} ${size} icon-spin`}/>
			);
		}
		
		if( props.typeinverted ) {
			return (
				<span class="icon-stack">
                <i className={`icon-${props.base} icon-stack-base`}/>
                <i className={`icon-${props.typeinverted} icon-light`}/>
				</span>
			);
		}
		
		if( props.base ) {
			return (
				<span class="icon-stack">
                <i className={`icon-${props.base} ${size} icon-stack-base}`}/>
                <i className={`icon-${props.type} ${size}`}/>
				</span>
			);
		}
		
		return (
			<i className={`icon-${props.type} ${size}`}/>
		);
	}
	if( props.tooltip ) {
		return <a href="#" title={props.tooltip}>
				   {inner()}
			   </a>;
	}
	else {
		return inner();
	}
}
