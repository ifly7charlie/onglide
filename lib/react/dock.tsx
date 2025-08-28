'use client';

import {useState, useCallback, useEffect} from 'react';

import {Settings} from './settings';

import {CoverageDetails} from './coveragedetails';
import {VisualisationSelector} from './visualisationselector';
import {FileSelector} from './fileselector';
import {StationSelector} from './stationselector';

import {map as _map, find as _find, filter as _filter} from 'lodash';

import {Dock as ReactDock} from 'react-dock';
import type {PickableDetails} from './pickabledetails';

export function Dock(props: {
    setStation: (station: string) => void; //
    station: string;
    setFile: (file: string) => void;
    file: string;
    hoverDetails: PickableDetails;
    selectedDetails: PickableDetails;
    setSelectedDetails: (sd?: PickableDetails) => void;
    setVisualisation: (visualisation: string) => void;
    visualisation: string;
    updateUrl: (a: Record<string, string>) => void;
    dockSplit: number;
    setDockSplit: (a: number) => void;
    dockPosition: 'right' | 'bottom';
    setDockPosition: (a: 'right' | 'bottom') => void;
    env: any;
}) {
    // Tooltip or sidebar
    const [expanded, setExpanded] = useState(true);

    const onDockVisibleChange = useCallback(
        (isVisible: boolean) => {
            setExpanded(isVisible);
        },
        [false]
    );
    const onDockResize = useCallback(
        (size: number) => {
            setExpanded(size > 0.04);
            if (size < 0.04) {
                size = 0;
            }
            props.setDockSplit(size);
        },
        [props.setDockSplit]
    );

    // Where to put the dock - need better way of dealing with mixed server/client rendering here
    const hasWindow = typeof window !== 'undefined';
    //    const dockPosition = 'right'; //
    useEffect(() => {
        props.setDockPosition(hasWindow && window.innerWidth < window.innerHeight ? 'bottom' : 'right');
    }, [hasWindow, window?.innerWidth, window?.innerHeight, props.setDockPosition]);

    return (
        <ReactDock
            isVisible={expanded}
            fluid={true} //
            onSizeChange={onDockResize}
            size={props.dockSplit}
            dimMode="none"
            position={props.dockPosition}
            onVisibleChange={onDockVisibleChange}
        >
            <div>
                <span style={{padding: '0px', border: '5px solid white'}}>
                    <img width="100" height="100" src="https://ognproject.wdfiles.com/local--files/logos/ogn-logo-150x150.png" alt="OGN Network" title="OGN Network" />
                </span>
            </div>

            <div style={{padding: '7px'}}>
                <StationSelector station={props.station} setStation={props.setStation} updateUrl={props.updateUrl} />
                <br />
                <FileSelector station={props.station} setFile={props.setFile} file={props.file} />
                <br />
                <VisualisationSelector station={props.station} setVisualisation={props.setVisualisation} visualisation={props.visualisation} />
                <br />
                <hr />
                {expanded ? (
                    <CoverageDetails //
                        details={props.selectedDetails.type !== 'none' ? props.selectedDetails : props.hoverDetails}
                        locked={props.selectedDetails.type !== 'none'}
                        setSelectedDetails={props.setSelectedDetails}
                        station={props.station}
                        setStation={props.setStation}
                        file={props.file}
                        setFile={props.setFile}
                        env={props.env}
                    />
                ) : null}
            </div>
            <Settings updateUrl={props.updateUrl} env={props.env} />
        </ReactDock>
    );
}
