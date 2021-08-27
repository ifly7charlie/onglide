import next from 'next'
import { useRouter } from 'next/router'
import Head from 'next/head'

// What do we need to render the bootstrap part of the page
import Container from 'react-bootstrap/Container';
import Row from 'react-bootstrap/Row';
import Col from 'react-bootstrap/Col';
import Collapse from 'react-bootstrap/Collapse';
import Navbar from 'react-bootstrap/Navbar'
import Nav from 'react-bootstrap/Nav'
import NavDropdown from 'react-bootstrap/NavDropdown'

import { useState, useRef } from 'react';

// Helpers for loading contest information etc
import { useContest, usePilots, useTask, Spinner, Error } from '../lib/react/loaders.js';
import { Nbsp, Icon } from '../lib/react/htmlhelper.js';

// And connect to websockets...
import { OgnFeed } from '../lib/react/ognfeed.js';

import Router from 'next/router'

import pilotsorting from '../lib/react/pilot-sorting.js';
import { query } from '../lib/react/db';

import cookies from 'next-cookies';

import _find from 'lodash.find';

function IncludeJavascript() {
    return (
        <>
            <link rel="stylesheet" href="/bootstrap/css/font-awesome.min.css"/>
            <link href='//api.mapbox.com/mapbox-gl-js/v1.11.0/mapbox-gl.css' rel='stylesheet' />
        </>
    );
}


// Requires: classes, link, contestname, contestdates

function Menu( props ) {

    const comp = props.comp;
    const classes = comp.classes.map( (c) => <Nav.Item key={'navitem'+c.class}>
                                                 <Nav.Link href='#'
                                                           key={'navlink'+c.class}
                                                           eventKey={c.class}
                                                           onClick={() => { Router.push('/?className='+c.class, undefined, {shallow:true});
                                                                            props.setSelectedPilot(null);}}>
                                                     {c.classname}{c.status == 'L'?<><Nbsp/><Icon type="plane"/></>:null}
                                                 </Nav.Link>
                                             </Nav.Item>);

	// Try and extract a short form of the name, only letters and spaces stop at first number
	const shortName = comp.competition.name.match( new RegExp(/^([\p{L}\s]*)/,'u'))?.[1]?.trim() || comp.competition.name;
    return (
        <>
            <Navbar bg="light" fixed="top">
                <Nav fill variant="tabs" defaultActiveKey={props.vc} style={{width:'100%'}}>
                    {classes}
					<Nav.Item key="sspot" style={{paddingTop:0,paddingBottom:0}}>
						<Nav.Link href={comp.competition.mainwebsite}  className="d-md-none">
							{shortName}<Nbsp/><Icon type='external-link'/>
						</Nav.Link>
						<Nav.Link href={comp.competition.mainwebsite}  className="d-none d-md-block"  style={{paddingTop:0,paddingBottom:0}}>
							{comp.competition.name}<div style={{fontSize: '70%'}}>{comp.competition.start} to {comp.competition.end}<Icon type='external-link'/> </div>
						</Nav.Link>
					</Nav.Item>
					<Nav.Item key="settings">
						<Nav.Link href='#' key='navlinksettings' eventKey='settings'
								  onClick={() => { Router.push('/settings', undefined, {shallow:true}); }}>
							<Icon type='cog'/>
						</Nav.Link>
					</Nav.Item>
				</Nav>
            </Navbar>
            <br style={{clear:'both'}}/>
        </>
    );
}

//
// Main page rendering :)
function CombinePage( props ) {

    // First step is to extract the class from the query, we use
    // query because that stops page reload when switching between the
    // classes. If no class is set then assume the first one
    const router = useRouter()
    let { className } = router.query;
    if (!className) {
        className = props.defaultClass;
    }

    // Next up load the contest and the pilots, we can use defaults for pilots
    // if the className matches
    const { comp, isLoading, error } = useContest();

    // And keep track of who is selected
    const [ selectedCompno, setSelectedCompno ] = useState();

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
//        pitch: 90
    });

	// 
    // And display in progress until they are loaded
    if (isLoading)
        return (<div className="loading">
                    <div className="loadinginner"/>
                </div>) ;

    if (error||!comp?.competition)
        return (<div>
                    <div style={{position:'fixed', zIndex:'10', marginLeft:'10px' }}>
                        <h1>
                            Welcome to Onglide
                        </h1>
                        <p>
                            Please see <a href="https://github.com/glidernet/onglide/blob/main/readme.md">readme.md</a> for setup instructions.
                        </p>
                        <p>
                            If you have configured the competition and the soaring spot load has completed but you are still seeing this screen then it may be your browser
                            cache. <a href="https://kb.iu.edu/d/ahic">Indiana U</a> has instructions if you are unsure how to do this.
                        </p>
                    </div>
                    <div className="loading">
                        <div className="loadinginner"/>
                    </div>
                </div>) ;


    // Make sure we have the class object
    const selectedClass = _find( comp.classes,{'class': className} );
	
	return (
        <>
            <Head>
                <title>{comp.competition.name} - {className}</title>
				<meta name='viewport' content='width=device-width, minimal-ui'/>
                <IncludeJavascript/>
            </Head>
            <Menu comp={comp} vc={className} setSelectedPilot={setSelectedCompno}/>
			<div className="resizingContainer" >
				<OgnFeed vc={className}
						 tz={props.tz} datecode={selectedClass?selectedClass.datecode:'07C'}
						 selectedCompno={selectedCompno} setSelectedCompno={setSelectedCompno}
						 viewport={viewport} setViewport={setViewport}
						 options={props.options} setOptions={props.setOptions}
				/>
			</div>
		</>
    );
}

//
// Determine the default class
export async function getServerSideProps(context) {
	const location = (await query( 'SELECT lt, lg, tzoffset, tz FROM competition LIMIT 1' ))?.[0];
    const classes = await query('SELECT class FROM classes ORDER BY class');

    return {
        props: { lat: location?.lt||51, lng: location?.lg||0, tzoffset: location?.tzoffset||0, tz: location?.tz||'Etc/UTC',
				 defaultClass: classes && classes.length > 0 ? classes[0].class : '',
				 options: cookies(context).options || { rainRadar: 1, rainRadarAdvance: 0, units: 0, mapType: 0, taskUp: 1 }}
	};
}

export default CombinePage;
