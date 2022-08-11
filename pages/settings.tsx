import next from 'next';
import dynamic from 'next/dynamic';
import Head from 'next/head';
import Router from 'next/router';
import {useRouter} from 'next/router';
import Link from 'next/link';

// What do we need to render the bootstrap part of the page
import Container from 'react-bootstrap/Container';
import Row from 'react-bootstrap/Row';
import Col from 'react-bootstrap/Col';
import Collapse from 'react-bootstrap/Collapse';
import Navbar from 'react-bootstrap/Navbar';
import Nav from 'react-bootstrap/Nav';
import NavDropdown from 'react-bootstrap/NavDropdown';
import ButtonGroup from 'react-bootstrap/ButtonGroup';
import ToggleButton from 'react-bootstrap/ToggleButton';

import {Nbsp} from '../lib/react/htmlhelper';

import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faLink, faGears, faPaperPlane} from '@fortawesome/free-solid-svg-icons';

import {query} from '../lib/react/db';
import {useContest, Spinner} from '../lib/react/loaders';
import cookies from 'next-cookies';

import _find from 'lodash.find';

function IncludeJavascript() {
    return (
        <>
            <link rel="stylesheet" href="/bootstrap/css/font-awesome.min.css" />
        </>
    );
}

// Requires: classes, link, contestname, contestdates

function Menu(props) {
    const comp = props.comp;
    const classes = comp.classes.map((c) => (
        <Nav.Item key={'navitem' + c.class}>
            <Nav.Link
                href="#"
                key={'navlink' + c.class}
                eventKey={c.class}
                onClick={() => {
                    Router.push('/?className=' + c.class, undefined, {shallow: true});
                }}
            >
                {c.classname}
                {c.status == 'L' ? (
                    <>
                        <Nbsp />
                        <FontAwesomeIcon icon={faPaperPlane} />
                    </>
                ) : null}
            </Nav.Link>
        </Nav.Item>
    ));

    // Try and extract a short form of the name, only letters and spaces stop at first number
    const shortName = comp.competition.name.match(new RegExp(/^([\p{L}\s]*)/, 'u'))?.[1]?.trim() || comp.competition.name;
    return (
        <>
            <Navbar bg="light" fixed="top">
                <Nav fill variant="tabs" defaultActiveKey="settings" style={{width: '100%'}}>
                    {classes}
                    <Nav.Item key="sspot" style={{paddingTop: 0, paddingBottom: 0}}>
                        <Nav.Link href={comp.competition.mainwebsite} className="d-md-none">
                            {shortName}
                            <Nbsp />
                            <FontAwesomeIcon icon={faLink} />
                        </Nav.Link>
                        <Nav.Link href={comp.competition.mainwebsite} className="d-none d-md-block" style={{paddingTop: 0, paddingBottom: 0}}>
                            {comp.competition.name}
                            <div style={{fontSize: '70%'}}>
                                {comp.competition.start} to {comp.competition.end}
                                <FontAwesomeIcon icon={faLink} />{' '}
                            </div>
                        </Nav.Link>
                    </Nav.Item>
                    <Nav.Item key="settings">
                        <Nav.Link
                            href="#"
                            key="navlinksettings"
                            eventKey="settings"
                            onClick={() => {
                                Router.push('/settings', undefined, {shallow: true});
                            }}
                        >
                            <FontAwesomeIcon icon={faGears} />
                        </Nav.Link>
                    </Nav.Item>
                </Nav>
            </Navbar>
            <br style={{clear: 'both'}} />
        </>
    );
}

//
// Main page rendering :)
function SettingsPage({options, setOptions, tz}) {
    // Check if manual maptype was specified
    const router = useRouter();
    let {mapType} = router.query;
    if (mapType) {
        options.mapType = parseInt(mapType as string);
        console.log('mapType:', mapType);
    }

    // Next up load the contest and the pilots, we can use defaults for pilots
    // if the className matches
    const {comp, isLoading, isError} = useContest();

    function setOptionsAndCookie(o) {
        document.cookie = `options=${JSON.stringify(o)}; path=/`;
        setOptions(o);
    }
    console.log(options);

    // And display in progress until they are loaded
    if (isLoading) return <Spinner />;

    if (isError || !comp.competition)
        return (
            <div>
                <div style={{position: 'fixed', zIndex: '10', marginLeft: '10px'}}>
                    <h1>Welcome to Onglide</h1>
                    <p>
                        Please see <a href="https://github.com/glidernet/onglide/blob/main/readme.md">readme.md</a> for setup instructions.
                    </p>
                    <p>
                        If you have configured the competition and the soaring spot load has completed but you are still seeing this screen then it may be your browser cache. <a href="https://kb.iu.edu/d/ahic">Indiana U</a> has instructions if you are unsure how to do this.
                    </p>
                </div>
                <div className="loading">
                    <div className="loadinginner" />
                </div>
            </div>
        );

    return (
        <>
            <Head>
                <title>{comp.competition.name} - Settings</title>
                <IncludeJavascript />
            </Head>
            <Menu comp={comp} />
            <br style={{clear: 'both'}} />
            <Container fluid>
                <Row>
                    <Col sm={7}>
                        <h1>Welcome to Onglide</h1>

                        <Row>
                            <Col sm={3}>Display Units</Col>
                            <Col>
                                <ButtonGroup key="units">
                                    {['metric', 'imperial'].map((radio, idx) => (
                                        <ToggleButton key={idx} id={'units' + idx} variant="secondary" type="radio" value={idx} checked={idx === options.units} onChange={(e) => setOptionsAndCookie({...options, units: idx})}>
                                            {radio}
                                        </ToggleButton>
                                    ))}
                                </ButtonGroup>
                            </Col>
                        </Row>
                        <hr />
                        <Row>
                            <Col sm={3}>Map orientation when following</Col>
                            <Col>
                                <ButtonGroup key="mapOrientation">
                                    {['North Up', 'Next Turnpoint Up', "Don't Change"].map((radio, idx) => (
                                        <ToggleButton key={idx} id={'mapOrientation' + idx} variant="secondary" type="radio" value={idx} checked={idx === options.taskUp} onChange={(e) => setOptionsAndCookie({...options, taskUp: idx})}>
                                            {radio}
                                        </ToggleButton>
                                    ))}
                                </ButtonGroup>
                            </Col>
                        </Row>
                        <Row>
                            <br />
                            <Col sm={3}>Map Type</Col>
                            <Col>
                                <ButtonGroup key="mapType">
                                    {['3D satellite', '3D road', '2D satellite', '2D road'].map((radio, idx) => (
                                        <ToggleButton key={idx} id={'mapType' + idx} variant="secondary" type="radio" value={idx} checked={idx === options.mapType} onChange={(e) => setOptionsAndCookie({...options, mapType: idx})}>
                                            {radio}
                                        </ToggleButton>
                                    ))}
                                </ButtonGroup>
                            </Col>
                        </Row>
                        <br />
                        <Row>
                            <Col sm={3}>Rain Radar</Col>
                            <Col>
                                <ButtonGroup key="rain">
                                    {['off', 'actual', 'forecast +10m', 'forecast +20m'].map((radio, idx) => (
                                        <ToggleButton key={idx} id={'rain' + idx} variant="secondary" type="radio" value={radio} checked={idx === options.rainRadarAdvance + 1} onChange={(e) => setOptionsAndCookie({...options, rainRadarAdvance: idx - 1, rainRadar: idx > 0})}>
                                            {radio}
                                        </ToggleButton>
                                    ))}
                                </ButtonGroup>
                            </Col>
                        </Row>
                        <Row>
                            <Col sm={3}>
                                <Nbsp />
                            </Col>
                            <Col>(You can toggle through different times by clicking on the time next to the Rain Viewer credit on the main map)</Col>
                        </Row>
                        <hr />
                        <Row style={{overflow: 'auto'}}>
                            <Col sm={3}>
                                <h5>Info</h5>
                            </Col>
                            <Col>
                                If you would like to use it for your competition please email me at melissa-onglide@littlebluecar.co.uk with your <Link href="https://kb.naviter.com/en/kb/public-api-for-soaring-spot/">SoaringSpot API keys</Link>, likewise for bugs.
                                <br />
                                I normally ask for some commitment to help get more women into gliding.
                                <hr />
                                Pilot images are taken from the FAI ranking list (<Link href="https://igcrankings.fai.org">http://igcrankings.fai.org</Link>) and require the FAI number to be correctly entered into the competition.
                                <br />
                                <hr />
                                Flarm IDs are matched based on launches from configured airfield coordinates and the <Link href="https://ddb.glidernet.org">OGN DDB</Link>, you can add your glider there if it isn't matched. The IGC files will also be analysed to see if a launch/landing time match can be made. This happens after the trace is available from scoring so may take a few days to pick up gliders.
                                <hr />
                                Onglide is an open source project (<Link href="https://github.com/glidernet/onglide">https://github.com/glidernet/onglide</Link>) written in Javascript (Next.js/Bootstrap/Mapbox) and contributions and bug fixes are always welcome! And yes there are plenty of bugs - this was written under various tents at gliding competitions.
                                <br />
                                <hr />
                                Onglide does not use any cookies except to pass the mapbox token to mapbox and to store your settings. These cookies are 'Strictly necessary' for the site to function according to the ePrivacy directive.
                            </Col>
                        </Row>
                    </Col>
                </Row>
            </Container>
        </>
    );
}

//
// Determine the default class
export async function getServerSideProps(context) {
    const location = (await query('SELECT lt, lg, tzoffset, tz FROM competition LIMIT 1'))?.[0];

    return {
        props: {lat: location?.lt || 51, lng: location?.lg || 0, tzoffset: location?.tzoffset || 0, tz: location?.tz || 'Etc/UTC', options: cookies(context).options || {rainRadar: 1, rainRadarAdvance: 0, units: 0, mapType: 0, taskUp: 1}}
    };
}

export default SettingsPage;
