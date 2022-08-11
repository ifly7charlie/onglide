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

import {MapView, GeoJsonLayer, PathLayer, TextLayer, IconLayer} from '@deck.gl/layers';
import GL from '@luma.gl/constants';

export class OgnPathLayer extends PathLayer {
    constructor(a) {
        super(a);
    }

    initializeState() {
        super.initializeState();

        super.getAttributeManager().addInstanced({
            instancePickingColors: {
                size: 3,
                type: GL.UNSIGNED_BYTE,
                update: this.calculatePickingColors
            }
        });
    }

    // Deckgl generates an offscreen pixmap that it renders z-order into and the
    // colour is then used to figure out what has been picked. We use the index
    // from the start of the timing array to determine the picking colour
    calculatePickingColors(attribute) {
        //        console.log(this.props.data);

        const {value} = attribute;

        let i = 0;
        for (const object of this.props.data.timing) {
            const pickingColor = super.encodePickingColor(i);
            value[i * 3] = pickingColor[0];
            value[i * 3 + 1] = pickingColor[1];
            value[i * 3 + 2] = pickingColor[2];
            i++;
        }
    }

    // This function is called to convert from colour back into specific data
    // we enrich it with what we can collect from our props.data attributes
    getPickingInfo(pickParams) {
        const info = super.getPickingInfo(pickParams);
        const props = pickParams?.info?.layer?.props;
        if (info.picked && props && props.data) {
            const coordinate = props.data.attributes.positions.value.subarray(pickParams.info.index * 3, (pickParams.info.index + 1) * 3);
            info.object = {compno: props.compno, lat: coordinate[0], lng: coordinate[1], alt: Math.floor(coordinate[2]), agl: props.data?.agl[pickParams.info.index], climbRate: props.data?.climbRate[pickParams.info.index] || undefined, time: props.data.timing[pickParams.info.index]};
        }
        return info;
    }
}
