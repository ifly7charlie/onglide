import {configureStore} from '@reduxjs/toolkit';

import tracksSlice from '../redux/tracksSlice';
import nowSlice from '../redux/nowSlice';
import scoresSlice from '../redux/scoresSlice';
import otherPilotsSlice from '../redux/otherPilotsSlice';

// ...

const store = configureStore({
    reducer: {
        tracks: tracksSlice,
        scores: scoresSlice,
        otherPilots: otherPilotsSlice,
        now: nowSlice
    },
    middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware({
            immutableCheck: false,
            serializableCheck: false /*{
                // Ignore these action types
                ignoredActions: ['tracks/updateTracks', 'tracks/fetchOldTracks/fulfilled', 'scores/fetchOldScores/fulfilled'],
                // Ignore these field paths in all actions
                ignoredPaths: ['tracks']
                // Ignore these paths in the state
            } */
        })
});

export type RootState = ReturnType<typeof store.getState>;

// Inferred type: {posts: PostsState, comments: CommentsState, users: UsersState}
export type AppDispatch = typeof store.dispatch;

export default store;
