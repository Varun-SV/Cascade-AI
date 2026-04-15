import { configureStore } from '@reduxjs/toolkit';
import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux';
import runtimeReducer from './slices/runtimeSlice';

export const store = configureStore({
  reducer: {
    runtime: runtimeReducer,
  },
  // Serialisability check: Sets (used in logIds) are not serialisable by default.
  // We disable the check for that path only so we keep the O(1) dup detection.
  middleware: (getDefaultMiddleware: any) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredPaths: ['runtime.logIds'],
      },
    }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;