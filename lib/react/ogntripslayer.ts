//
//
// This class overrides the PathLayer point selection algorithm which normally just
// tells you what line segment is covered. By overriding this we can identify exactly
// what point on the line is hovered/clicked and use that to display information about
// the specific spot on the trace like the time or climb rate.
//
//
// FWIW If a plane has good flarm coverage there will only be one segment as we
// only generate a new segment on gaps. Mapbox recommended one segment for each colour
// but that isn't needed for deckgl binary layers as we can specify a colour per vertex
// if we want. It also means that each segment is rendered as a line and there is no
// joining or smoothing which is less than ideal
//

import type {LayerData} from '@deck.gl/core';
import {TripsLayer} from '@deck.gl/geo-layers';
import GL from '@luma.gl/constants';

interface OgnTripsData {
    length: number;
    numberOfPoints: number;
    startIndices: Uint32Array;
    timing: Uint32Array;
    climbRate: Uint8Array;
    g: Int16Array;
}

export class OgnTripsLayer extends TripsLayer {
    constructor(a) {
        super(a);
    }

    initializeState() {
        super.initializeState();

        super.getAttributeManager().addInstanced({
            instancePickingColors: {
                size: 3,
                type: 'uint8', //GL.UNSIGNED_BYTE,
                update: this.calculatePickingColors
            }
        });
    }

    // Deckgl generates an offscreen pixmap that it renders z-order into and the
    // colour is then used to figure out what has been picked. We use the index
    // from the start of the timing array to determine the picking colour
    calculatePickingColors(attribute) {
        const data = this.props.data as OgnTripsData;
        if (!attribute.state.needsUpdate) {
            return;
        }
        const {value} = attribute;
        for (let i = 0; i < data.numberOfPoints; i++) {
            const pickingColor = super.encodePickingColor(i);
            value[i * 3] = pickingColor[0];
            value[i * 3 + 1] = pickingColor[1];
            value[i * 3 + 2] = pickingColor[2];
        }
        //        console.log(this.props.compno, this.props.data.length, attribute);
    }

    // This function is called to convert from colour back into specific data
    // we enrich it with what we can collect from our props.data attributes
    getPickingInfo(pickParams) {
        const info = super.getPickingInfo(pickParams);
        const props = pickParams?.info?.layer?.props;
        if (info.picked && props && props.data) {
            const coordinate = props.data.attributes.getPath.value.subarray(pickParams.info.index * 3, (pickParams.info.index + 1) * 3);
            info.object = {
                compno: props.compno, //
                a: Math.floor(coordinate[2]),
                g: props.data?.g[pickParams.info.index],
                v: props.data?.v[pickParams.info.index] || undefined,
                t: props.data.t[pickParams.info.index]
            };
        }
        return info;
    }
}
