///import next from 'next';
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

//import {pilotsorting} from '../lib/react/pilot-sorting.js';
import {query} from '../lib/react/db';
import escape from 'sql-template-strings';
import {Options} from '../lib/react/options';

import {useMeasure} from '../lib/react/measure';

import cookies from 'next-cookies';

import _find from 'lodash.find';

function IncludeJavascript() {
    return (
        <>
            <link rel="stylesheet" href="/bootstrap/css/font-awesome.min.css" />
            <link href="//api.mapbox.com/mapbox-gl-js/v2.3.0/mapbox-gl.css" rel="stylesheet" />
        </>
    );
}

// Requires: classes, link, contestname, contestdates

function Menu(props) {
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
                              Router.push('/?className=' + c.class, undefined, {shallow: true});
                              props.setSelectedPilot(null);
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
              ))
            : null;

    // Try and extract a short form of the name, only letters and spaces stop at first number
    const shortName =
        comp.competition.name
            .replace(/.*Women's World Gliding Championship[s]*/gi, 'WWGC')
            .replace(/.*World Gliding Championship[s]*/gi, 'WGC')
            .match(new RegExp(/^([0-9]*[\p{L}\s]*)/, 'u'))?.[1]
            ?.trim() || comp.competition.name.substring(0, 25) + '...';

    return (
        <>
            <Navbar bg="light" fixed="top">
                <Nav fill variant="tabs" defaultActiveKey={props.vc} style={{width: '100%'}}>
                    {classes}
                    <Nav.Item key="sspot" style={{paddingTop: 0, paddingBottom: 0}}>
                        <Nav.Link href={comp.competition.mainwebsite} className="d-lg-none">
                            {shortName}
                            <Nbsp />
                            <FontAwesomeIcon icon={faLink} />
                        </Nav.Link>
                        <Nav.Link href={comp.competition.mainwebsite} className="d-none d-lg-block" style={{paddingTop: 0, paddingBottom: 0}}>
                            {comp.competition.name}
                            <div style={{fontSize: '70%'}}>
                                {comp.competition.start} to {comp.competition.end}
                                <FontAwesomeIcon icon={faLink} />{' '}
                            </div>
                        </Nav.Link>
                    </Nav.Item>
                    <Nav.Item key="settings">
                        <Options {...props} />
                    </Nav.Item>
                </Nav>
            </Navbar>
            <br style={{clear: 'both'}} />
        </>
    );
}

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

    // Next up load the contest and the pilots, we can use defaults for pilots
    // if the className matches
    const {comp, isLoading, isError} = useContest();
    //    console.log(props);
    //    console.log(comp);

    // And keep track of who is selected
    const [selectedCompno, setSelectedCompno] = useState();
    const measureFeatures = useMeasure();

    // What the map is looking at
    const [viewport, setViewport] = useState({
        latitude: props.lat,
        longitude: props.lng,
        zoom: 11.5,
        minZoom: 6.5,
        maxZoom: 14,
        bearing: 0,
        minPitch: 0,
        maxPitch: 85,
        altitude: 1.5,
        pitch: !(props.options.mapType % 2) ? 70 : 0
    });

    //
    // And display in progress until they are loaded
    if (isLoading)
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
                <Menu comp={comp} vc={className} setSelectedPilot={setSelectedCompno} measureFeatures={measureFeatures} options={props.options} setOptions={props.setOptions} />
                <h1>Please choose a class from the menu bar</h1>
            </>
        );
    }

    return (
        <>
            <Head>
                <title>
                    {comp.competition.name} - {className}
                </title>
                <meta name="viewport" content="width=device-width, minimal-ui" />
                <link rel="manifest" href="/manifest.json" />
                <IncludeJavascript />
            </Head>
            <Menu comp={comp} vc={className} setSelectedPilot={setSelectedCompno} measureFeatures={measureFeatures} options={props.options} setOptions={props.setOptions} />
            <div className="resizingContainer">
                <OgnFeed vc={className} tz={props.tz} datecode={selectedClass ? selectedClass.datecode : '07C'} selectedCompno={selectedCompno} setSelectedCompno={setSelectedCompno} viewport={viewport} setViewport={setViewport} options={props.options} setOptions={props.setOptions} measureFeatures={measureFeatures} handicapped={selectedClass?.handicapped == 'Y'} notes={selectedClass?.notes} />
            </div>
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
            props: {lat: location?.lt || 51, lng: location?.lg || 0, tzoffset: location?.tzoffset || 0, tz: location?.tz || 'Etc/UTC', defaultClass: classes && classes.length > 0 ? classes[0].class : '', options: cookies(context).options || {rainRadar: 1, rainRadarAdvance: 0, units: 0, mapType: 3, taskUp: 0, follow: true}}
        };
    } catch (e) {
        console.log(e);
    }
    //    return {
    //      props: {lat: 52.4393, lng: -1.04162, tzoffset: 3600, tz: 'Europe/London', defaultClass: '18Metre', options: cookies(context).options || {rainRadar: 1, rainRadarAdvance: 0, units: 0, mapType: 3, taskUp: 0, follow: true}}
    //    };
}
