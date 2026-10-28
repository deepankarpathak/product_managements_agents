import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App.js';
import reportWebVitals from './reportWebVitals.js';

// Dev only: React 19.2 logs each component's changed props to the Performance timeline via
// performance.measure({ detail }). The browser structured-clones `detail`, and dashboards that
// pass very large result arrays as props (Unified SR state is ~28 MB) make that clone fail with
// "DataCloneError: Data cannot be cloned, out of memory", which React surfaces as a runtime
// error. Retry without the props payload so the timing is still recorded.
if (process.env.NODE_ENV === 'development' && typeof performance !== 'undefined' && performance.measure) {
  const measure = performance.measure.bind(performance);
  performance.measure = (name, options, ...rest) => {
    try {
      return measure(name, options, ...rest);
    } catch (err) {
      if (err?.name !== 'DataCloneError' || !options || typeof options !== 'object' || !('detail' in options)) throw err;
      // eslint-disable-next-line no-unused-vars
      const { detail, ...withoutDetail } = options;
      return measure(name, withoutDetail, ...rest);
    }
  };
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
