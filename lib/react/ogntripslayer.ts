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

import {TripsLayer} from '@deck.gl/geo-layers';

import {referenceDate} from '../flightprocessing/referenceDate';

interface OgnTripsData {
    length: number;
    numberOfPoints: number;
    startIndices: Uint32Array;
    v: Uint8Array;
    g: Int16Array;
    anchorIndex?: Uint32Array;
}

type _OgnTripsLayerProps<DataT = unknown> = {
    startTime?: number;
};

const startUniforms = {
    name: 'starts',
    fs: `uniform startsUniforms {
  float startTime;
} starts;`,
    uniformTypes: {
        startTime: 'f32'
    }
};

export class OgnTripsLayer extends TripsLayer<OgnTripsData, _OgnTripsLayerProps> {
    constructor(a) {
        super(a);
    }

    static layerName = 'OgnTripsLayer';

    getShaders() {
        const shaders = super.getShaders();
        shaders.modules = [...(shaders.modules || []), startUniforms];
        shaders.inject['fs:#main-start'] += `
if(vTime < starts.startTime) {
discard;
}`;
        return shaders;
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

    draw(params) {
        const {startTime} = this.props;
        const model = this.state.model!;
        model.shaderInputs.setProps({starts: {startTime: startTime ?? 0}});
        super.draw(params);
    }

    // Deckgl generates an offscreen pixmap that it renders z-order into and the
    // colour is then used to figure out what has been picked. We use the index
    // from the start of the timing array to determine the picking colour
    calculatePickingColors(attribute, {data, startRow, endRow}: {data: OgnTripsData; startRow: number; endRow: number}) {
        if (!attribute.needsUpdate) {
            return;
        }
        const {value} = attribute;
        const firstPoint = data.startIndices[startRow || 0];
        const lastPoint = Math.min(data.numberOfPoints - 1, data.startIndices[Math.min(endRow, data.length)] ?? data.numberOfPoints - 1);
        for (let i = firstPoint, j = firstPoint * 3; i <= lastPoint; i++, j += 3) {
            super.encodePickingColor(i, value.subarray(j, j + 3));
        }
    }

    // This function is called to convert from colour back into specific data
    // we enrich it with what we can collect from our props.data attributes
    getPickingInfo(pickParams) {
        const info = super.getPickingInfo(pickParams);
        const props = pickParams?.info?.layer?.props;
        if (info.picked && props && props.data) {
            const coordinate = props.data.attributes.getPath.value.subarray(pickParams.info.index * 3, (pickParams.info.index + 1) * 3);
            // getTimestamps.value is fractional seconds-from-referenceDate (see
            // lib/react/deckvh.ts); add referenceDate to recover epoch-seconds
            // for the tooltip.
            const tr = props.data.attributes.getTimestamps.value[pickParams.info.index];
            // A smoothed vertex is a real fix (anchor) iff it's the last vertex
            // in its anchorIndex run — the Hermite inner vertices emitted ahead
            // of an anchor share that anchor's index (see spline.ts). So a match
            // with the next vertex's anchorIndex means this one is interpolated.
            // No anchorIndex => raw fallback, every vertex is a real fix.
            const idx = pickParams.info.index;
            const anchorIndex = props.data.anchorIndex;
            const interpolated = !!anchorIndex && idx + 1 < props.data.numberOfPoints && anchorIndex[idx] === anchorIndex[idx + 1];
            info.object = {
                compno: props.compno, //
                a: Math.floor(coordinate[2]),
                g: props.data?.g[pickParams.info.index],
                v: props.data?.v[pickParams.info.index] || undefined,
                t: Math.round(tr + referenceDate),
                interpolated
            };
        }
        return info;
    }
}
