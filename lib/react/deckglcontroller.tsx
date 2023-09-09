import {MapController} from 'deck.gl';

export class StopFollowController extends MapController {
    setFollow: Function;

    constructor(options: any = {}) {
        super(options);
        //        this.setFollow = options.setFollow;
    }

    handleEvent(event) {
        if (event.type == 'panstart') {
            //            this.setFollow(false);
        }
        super.handleEvent(event);
    }
}
