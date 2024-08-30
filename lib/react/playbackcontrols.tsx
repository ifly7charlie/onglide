import * as React from 'react';
import {styled} from '@mui/material/styles';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Slider from '@mui/material/Slider';

import {useSelector, useDispatch} from '../redux';
import {fetchOldScores} from '../redux/scoresSlice';
import {selectLatestUpdate} from '../redux/tracksSlice';
import {selectOnline, selectClassName, selectDatecode, selectScoreId} from '../redux/nowSlice';

const Widget = styled('div')(({theme}) => ({
    padding: 24,
    paddingBottom: 8,
    borderRadius: 16,
    width: '85%',
    maxWidth: '100%',
    margin: 'auto',
    position: 'relative',
    zIndex: 1,
    backgroundColor: theme.palette.mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.4)',
    backdropFilter: 'blur(40px)'
}));

const TinyText = styled(Typography)({
    fontSize: '0.75rem',
    opacity: 0.38,
    fontWeight: 500,
    letterSpacing: 0.2
});

const SliderContainer = styled(Box)({width: '100%', overflow: 'hidden'});

const BoxAfter = styled(Box)({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: '-1rem'
});

const BoxBefore = styled(Box)({
    display: 'flex',
    alignItems: 'right',
    justifyContent: 'space-between',
    marginTop: '-1rem'
});

const TimeSlider = styled(Slider)({
    color: 'rgba(0,128,0,0.87)',
    marginTop: '-1rem',
    height: 4,
    '& .MuiSlider-thumb': {
        width: 8,
        height: 8,
        transition: '0.3s cubic-bezier(.47,1.64,.41,.8)',
        '&::before': {
            boxShadow: '0 2px 12px 0 rgba(0,0,0,0.4)'
        },
        '&:hover, &.Mui-focusVisible': {
            boxShadow: `0px 0px 0px 8px 'rgb(0 0 0 / 16%)'`
        },
        '&.Mui-active': {
            width: 20,
            height: 20
        }
    },
    '& .MuiSlider-rail': {
        opacity: 0.28
    }
});
const sliderSxReplay = {
    color: 'rgba(0,0,0,0.87)'
};

const sliderOffline = {
    color: 'orange' //rgba(255,0,0,0.87)'
};

import type {TZ, Epoch, Datecode, ClassName} from '../types';

const PlaybackControls = ({
    earliestScore,
    latestScore,
    live,
    replayTime,
    setReplayTime,
    tz
}: //
{
    earliestScore: Epoch;
    latestScore: Epoch;
    replayTime: Epoch | undefined;
    live: boolean;
    setReplayTime: (t: Epoch | undefined) => void;
    tz: TZ;
}) => {
    function formatDuration(value: number) {
        const minute = Math.floor(value / 60);
        const secondLeft = value - minute * 60;
        return `${minute}:${secondLeft < 10 ? `0${secondLeft}` : secondLeft}`;
    }

    // Only update every 16 seconds (1<<4==16)
    const className = useSelector(selectClassName);
    const datecode = useSelector(selectDatecode);
    const scoreId = useSelector(selectScoreId);
    const latestTrackUpdate = useSelector(selectLatestUpdate, (a, b) => a >> 4 == b >> 4); // from tracks
    const replayEndTime = !live ? latestTrackUpdate : latestScore;

    const online = useSelector(selectOnline);

    const dispatch = useDispatch();
    const doSetTime = React.useCallback(
        (t: Epoch | undefined) => {
            const inReplay = !t || t >= replayEndTime - 60 ? false : true;
            setReplayTime(inReplay ? t : undefined);
            if (inReplay) {
                dispatch(fetchOldScores({t: t as Epoch, now: replayEndTime, className, datecode}));
            }
        },
        [dispatch, replayEndTime, className, datecode]
    );

    // If we change class/date we need to make sure the replay is loaded for this time
    // otherwise the score box will be empty
    React.useEffect(() => {
        doSetTime(replayTime);
    }, [className, scoreId]);

    function formatTimes(t) {
        const dt = new Date(t * 1000);
        return `${dt.toLocaleTimeString('uk', {timeZone: tz, hour: '2-digit', minute: '2-digit'})}`;
    }

    if (earliestScore > replayEndTime) {
        return null;
    }

    return (
        <SliderContainer className="d-lg-inline d-none">
            <Widget>
                <BoxBefore>
                    <TinyText>{formatTimes(earliestScore)}</TinyText>
                    {replayTime ? <TinyText>{formatTimes(replayTime)}</TinyText> : null}
                    <TinyText>{formatTimes(replayEndTime)}</TinyText>
                </BoxBefore>
                <TimeSlider //
                    aria-label="time-indicator"
                    size="small"
                    value={replayTime ?? replayEndTime}
                    min={earliestScore}
                    step={1}
                    max={replayEndTime}
                    onChange={(_, value) => doSetTime(value as Epoch)}
                    sx={replayTime ? sliderSxReplay : !online ? sliderOffline : undefined}
                />
                <BoxAfter>
                    {replayTime ? <TinyText>+{formatDuration(replayTime - earliestScore)}</TinyText> : <TinyText sx={{opacity: 1}}>{online ? 'Live' : 'Offline'}</TinyText>}
                    <TinyText>+{formatDuration(replayEndTime - earliestScore)}</TinyText>
                </BoxAfter>
            </Widget>
        </SliderContainer>
    );
};

export default React.memo(
    PlaybackControls,
    (a, b) =>
        a.earliestScore == b.earliestScore && //
        a.latestScore == b.latestScore &&
        a.live == b.live &&
        (a.replayTime ?? 0) >> 4 == (b.replayTime ?? 0) >> 4
);
