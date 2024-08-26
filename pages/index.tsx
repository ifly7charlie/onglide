///import next from 'next';
import {memo} from 'react';
import {useRouter} from 'next/router';
import Head from 'next/head';

// What do we need to render the bootstrap part of the page
import Navbar from 'react-bootstrap/Navbar';
import Nav from 'react-bootstrap/Nav';

import {useState} from 'react';

import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faLink, faGears, faPaperPlane} from '@fortawesome/free-solid-svg-icons';

// Helpers for loading contest information etc
import {useContest, Spinner} from '../lib/react/loaders';
import {Nbsp} from '../lib/react/htmlhelper';

// And connect to websockets...
import {OgnFeed} from '../lib/react/ognfeed';

import Router from 'next/router';

import {query} from '../lib/react/db';
import escape from 'sql-template-strings';
import {Options} from '../lib/react/options';

import {MeasureContext} from '../lib/react/measure';
import {ClassName} from '../lib/types';

import {find as _find, isEqual as _isEqual} from 'lodash';

import {Provider} from 'react-redux';
import store from '../lib/redux/store';

const Menu = memo(
    function Menu(props: {comp: any; setSelectedPilot: Function; options: any; setOptions: Function; vc: string}) {
        const comp = props.comp;
        const classes =
            comp.classes.length > 1
                ? comp.classes.map((c) => (
                      <Nav.Item key={'navitem' + c.class}>
                          <Nav.Link
                              href="#"
                              key={'navlink' + c.class}
                              eventKey={c.class}
                              onClick={() => {
                                  props.setSelectedPilot(null);
                                  Router.push('/?className=' + c.class, undefined, {shallow: true}).then(() => props.setOptions({...props.options, zoomTask: true}));
                              }}
                          >
                              {c.classname.replace(/\s+(meter|metre)/, 'm')}
                          </Nav.Link>
                      </Nav.Item>
                  ))
                : null;

        // Try and extract a short form of the name, only letters and spaces stop at first number
        const shortNameStart = (
            comp.competition.name
                .replace(/.*Women's World Gliding Championship[s]*/gi, 'WWGC')
                .replace(/.*World Gliding Championship[s]*/gi, 'WGC')
                .replace(/.*European Gliding Championship[s]*/gi, 'EGC')
                .replace(/.*Sailplane Grandprix]*/gi, 'SGP')
                //                .match(new RegExp(/^([0-9]*[\p{L}\s]*)/u, 'u'))?.[1]
                ?.trim() || comp.competition.name
        ).substring(0, 13);
        const shortName = shortNameStart + (shortNameStart.length === 13 ? '...' : '');

        return (
            <>
                <Navbar bg="light" expand="lg" fixed="top" collapseOnSelect>
                    <Navbar.Brand className="d-lg-none">
                        <FontAwesomeIcon icon={faLink} />
                        <Nbsp />
                        {shortName}
                        <span className="d-lg-none">{classes ? ' - ' + comp.classes.find((c) => c.class == props.vc)?.classname.replace(/\s+(meter|metre)/, 'm') : null}</span>
                    </Navbar.Brand>
                    <Navbar.Brand className="d-name d-xl-block">
                        <Nav.Link href={comp.competition.mainwebsite} className="d-none d-lg-block" style={{paddingTop: 0, paddingBottom: 0, paddingLeft: 5}}>
                            {comp.competition.name}
                            <div style={{fontSize: '70%'}}>
                                {comp.competition.start} to {comp.competition.end}
                                <FontAwesomeIcon icon={faLink} />{' '}
                            </div>
                        </Nav.Link>
                    </Navbar.Brand>
                    <Navbar.Toggle aria-controls="responsive-nav-bar" />
                    <Navbar.Collapse id="responsive-nav-bar" className="justify-content-end" style={{paddingRight: 15}}>
                        <Nav fill variant="underline" defaultActiveKey={props.vc} style={{width: '40vw'}}>
                            {classes}
                        </Nav>
                        <Nav.Item key="settings">
                            <Options {...props} multipleClasses={comp.classes.length > 1} />
                        </Nav.Item>
                    </Navbar.Collapse>
                </Navbar>
                <br style={{clear: 'both'}} />
            </>
        );
    },
    // Memo comparison, skip all the functions
    (o, n) => o.vc === n.vc && o.comp === n.comp && _isEqual(o.options, n.options)
);

//
// Main page rendering :)
export default function CombinePage(props) {
    // First step is to extract the class from the query, we use
    // query because that stops page reload when switching between the
    // classes. If no class is set then assume the first one
    const router = useRouter();
    let {className} = router.query;
    if (!className) {
        className = props.defaultClass;
    }
    if (Array.isArray(className)) {
        className = className[0];
    }

    // Next up load the contest and the pilots, we can use defaults for pilots
    // if the className matches
    const {comp, isLoading, isError} = useContest();

    // And keep track of who is selected
    const [selectedCompno, setSelectedCompno] = useState();

    // What the map is looking at
    const [viewport, setViewport] = useState({
        latitude: props.lat,
        longitude: props.lng,
        zoom: 8.5,
        minZoom: 6.5,
        maxZoom: 14.5,
        bearing: 0,
        minPitch: 0,
        maxPitch: 80,
        pitch: !props?.options?.map2d ? 70 : 0
    });

    //
    // And display in progress until they are loaded
    if (isLoading || !props.options)
        return (
            <div className="loading">
                <div className="loadinginner" />
            </div>
        );

    if (isError || !comp?.competition) return <Spinner />;

    // Make sure we have the class object
    const selectedClass = _find(comp.classes, {class: className});

    if (!selectedClass) {
        return (
            <>
                <Head>
                    <title>{comp.competition.name}</title>
                </Head>
                <Menu //
                    comp={comp}
                    vc={className}
                    setSelectedPilot={setSelectedCompno}
                    options={props.options}
                    setOptions={props.setOptions}
                />
                <h1>Please choose a class from the menu bar</h1>
            </>
        );
    }

    return (
        <>
            <MeasureContext>
                <Head>
                    <title>
                        {comp.competition.name} - {className}
                    </title>
                </Head>
                <Menu
                    comp={comp}
                    vc={className} //
                    setSelectedPilot={setSelectedCompno}
                    options={props.options}
                    setOptions={props.setOptions}
                />
                <div className="resizingContainer">
                    <Provider store={store}>
                        <OgnFeed
                            vc={className as ClassName} //
                            tz={props.tz}
                            datecode={selectedClass ? selectedClass.datecode : '07C'}
                            selectedCompno={selectedCompno}
                            setSelectedCompno={setSelectedCompno}
                            viewport={viewport}
                            setViewport={setViewport}
                            options={props.options}
                            setOptions={props.setOptions}
                            handicapped={selectedClass?.handicapped == 'Y'}
                            notes={selectedClass?.notes}
                        />
                    </Provider>
                </div>
            </MeasureContext>
        </>
    );
}

//
// Determine the default class
export async function getServerSideProps(context) {
    try {
        const location = (await query(escape`SELECT lt, lg, tzoffset, tz FROM competition LIMIT 1`))?.[0];
        const classes = await query(escape`SELECT class FROM classes ORDER BY class`);

        return {
            props: {
                lat: location?.lt || 51,
                lng: location?.lg || 0,
                tzoffset: location?.tzoffset || 0,
                tz: location?.tz || 'Etc/UTC',
                defaultClass: classes && classes.length > 0 ? classes[0].class : ''
            }
        };
    } catch (e) {
        console.log(e);
    }
    //    return {
    //      props: {lat: 52.4393, lng: -1.04162, tzoffset: 3600, tz: 'Europe/London', defaultClass: '18Metre', options: cookies(context).options || {rainRadar: 1, rainRadarAdvance: 0, units: 0, mapType: 3, taskUp: 0, follow: true}}
    //    };
}
