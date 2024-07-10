import {useSelector as useReduxSelector, useDispatch as useReduxDispatch, useStore as useReduxStore, TypedUseSelectorHook} from 'react-redux';

import type {AppDispatch, RootState} from './store';

export const useDispatch = useReduxDispatch.withTypes<AppDispatch>();
//export const useSelector = useReduxSelector.withTypes<RootState>()
export const useSelector: TypedUseSelectorHook<RootState> = useReduxSelector;
//export const useStore = useReduxStore.withTypes<typeof store>();
