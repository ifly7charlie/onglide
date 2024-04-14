import {useMemo} from 'react';

export default function Sponsor(props) {
    const sponsorList = [
        <img width="152" height="233" src="https://wwgc2022.co.uk/wp-content/uploads/2022/03/FAI-logo.jpg" alt="" title="FAI logo" />, //
        <img width="150" height="150" src="https://ognproject.wdfiles.com/local--files/logos/ogn-logo-150x150.png" alt="OGN Network" title="OGN Network" />,

        ...(process.env.NEXT_PUBLIC_SITEURL.startsWith('sgp')
            ? [
                  // FAI SPECIFIC
                  <img width="150" height="150" src="https://images.squarespace-cdn.com/content/v1/64ae992947c519518d98ef92/1bf29bf3-c7cd-42fa-b6b9-927a6bc41e82/LogFAI-SGP.png?format=150w" alt="FAI Sailplane Grand Prix" title="FAI Sailplane Grand Prix" />,
                  <img width="150" height="57" src="https://images.squarespace-cdn.com/content/v1/64ae992947c519518d98ef92/35174206-46ae-45f8-8348-95a6b56b8e49/LxNav.jpg" alt="LxNav" title="LxNav" />,
                  <img width="145" height="74" src="https://images.squarespace-cdn.com/content/v1/64ae992947c519518d98ef92/c27f9a03-c6fa-4054-be63-64ac77646446/Schempp-Hirth.png" />,
                  <img width="145" height="57" src="https://images.squarespace-cdn.com/content/v1/64ae992947c519518d98ef92/6b810832-df21-45b1-b338-5fd5d9e37b75/silentwings-1.jpg" />,
                  <img width="150" height="150" src="https://images.squarespace-cdn.com/content/v1/64ae992947c519518d98ef92/1bf29bf3-c7cd-42fa-b6b9-927a6bc41e82/LogFAI-SGP.png?format=150w" alt="FAI Sailplane Grand Prix" title="FAI Sailplane Grand Prix" />,
                  <img width="145" height="46" src="https://images.squarespace-cdn.com/content/v1/64ae992947c519518d98ef92/4e86848d-8e4e-4e19-a18a-229ef2522d6c/CrosscountryAero-1.jpg" />,
                  <img width="150" height="150" src="https://images.squarespace-cdn.com/content/v1/64ae992947c519518d98ef92/7b75e0da-ff81-4b3f-965b-91b08f60d9bf/AS-1.jpg" />
              ]
            : [
                  <div>
                      If you would like to use onglide for your competition please ask your scorer to send the SoaringSpot API keys to setup@onglide.com
                      <hr />
                      For feedback, bug reports etc please use <a href="https://github.com/ifly7charlie/onglide/issues">GitHub issues reporting</a>
                      <br />
                      Pull Requests welcome
                  </div>
              ]),

        <img width="152" height="233" src="https://wwgc2022.co.uk/wp-content/uploads/2022/03/FAI-logo.jpg" alt="" title="FAI logo" />,
        <img width="150" height="150" src="https://ognproject.wdfiles.com/local--files/logos/ogn-logo-150x150.png" alt="OGN Network" title="OGN Network" />
    ];

    const currentSponsor = useMemo(() => sponsorList[Math.trunc(props.at / 60) % sponsorList.length], [Math.trunc(props.at / 60)]);

    return (
        <div className="details sponsor">
            <span style={{padding: '2px', border: '5px solid white'}}>{currentSponsor}</span>
        </div>
    );
}
