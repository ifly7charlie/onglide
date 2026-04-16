import {useMemo} from 'react';

const OGN_LOGO = (
    <a href="http://www.glidernet.org/" title="OGN Network" target="_blank" rel="noreferrer">
        <img width="120" height="120" src="https://ognproject.wdfiles.com/local--files/logos/ogn-logo-150x150.png" alt="OGN Network" />
    </a>
);

export default function Sponsor(props: {at: number}) {
    const sponsorList = [
        OGN_LOGO,
        ...(process.env.NEXT_PUBLIC_SITEURL?.startsWith('sgp')
            ? [
                  // FAI SPECIFIC
                  <img
                      width="150"
                      height="150"
                      src="https://images.squarespace-cdn.com/content/v1/64ae992947c519518d98ef92/1bf29bf3-c7cd-42fa-b6b9-927a6bc41e82/LogFAI-SGP.png?format=150w"
                      alt="FAI Sailplane Grand Prix"
                      title="FAI Sailplane Grand Prix"
                  />,
                  <img width="150" height="57" src="https://images.squarespace-cdn.com/content/v1/64ae992947c519518d98ef92/35174206-46ae-45f8-8348-95a6b56b8e49/LxNav.jpg" alt="LxNav" title="LxNav" />,
                  <img width="145" height="74" src="https://images.squarespace-cdn.com/content/v1/64ae992947c519518d98ef92/c27f9a03-c6fa-4054-be63-64ac77646446/Schempp-Hirth.png" />,
                  <img width="145" height="57" src="https://images.squarespace-cdn.com/content/v1/64ae992947c519518d98ef92/6b810832-df21-45b1-b338-5fd5d9e37b75/silentwings-1.jpg" />,
                  <img width="150" height="100" src="https://images.squarespace-cdn.com/content/v1/64ae992947c519518d98ef92/c71be420-e253-4b7d-8dec-d45f3a4ccd6b/TopMeteo.jpg" />,
                  <img width="150" height="50" src="https://images.squarespace-cdn.com/content/v1/5c2deead5b409b58c72bdba6/1546529524834-R3V7HCK516GTSOVJK696/Southern-Sailplanes-medium.png?format=150w" />,
                  <img width="145" height="46" src="https://images.squarespace-cdn.com/content/v1/64ae992947c519518d98ef92/4e86848d-8e4e-4e19-a18a-229ef2522d6c/CrosscountryAero-1.jpg" />,
                  <img width="150" height="150" src="https://images.squarespace-cdn.com/content/v1/64ae992947c519518d98ef92/7b75e0da-ff81-4b3f-965b-91b08f60d9bf/AS-1.jpg" />
              ]
            : [])
    ];

    const currentSponsor = useMemo(() => sponsorList[Math.trunc(props.at / 60) % sponsorList.length], [Math.trunc(props.at / 60)]);

    return <div className="sponsor">{currentSponsor}</div>;
}
