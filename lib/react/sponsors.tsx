import {useMemo} from 'react';

export default function Sponsor(props) {
    const sponsorList = [
        <img width="152" height="233" src="https://wwgc2022.co.uk/wp-content/uploads/2022/03/FAI-logo.jpg" alt="" title="FAI logo" />, //
        <img width="150" height="150" src="http://ognproject.wdfiles.com/local--files/logos/ogn-logo-150x150.png" alt="OGN Network" title="OGN Network" />
    ];

    const currentSponsor = useMemo(() => sponsorList[Math.trunc(props.at / 60) % sponsorList.length], [Math.trunc(props.at / 60)]);

    return (
        <div className="details sponsor">
            <span style={{padding: '2px', border: '5px solid white'}}>{currentSponsor}</span>
        </div>
    );
}
