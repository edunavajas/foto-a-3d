import { useCallback, useState } from 'react';
import Toast from './components/ui/toast/toast';
import MainView from './components/MainView.jsx';

/** Fixed toast area at the bottom edge; each uiarc Toast manages its own exit. */
function Toaster({ toasts, onDismiss }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
      {toasts.map(toast => (
        <div key={toast.id} className="pointer-events-auto">
          <Toast
            title={toast.title}
            description={toast.description}
            open
            onOpenChange={open => { if (!open) onDismiss(toast.id); }}
          />
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [toasts, setToasts] = useState([]);

  const notify = useCallback((title, description) => {
    const id = crypto.randomUUID();
    setToasts(current => [...current.slice(-2), { id, title, description }]);
  }, []);

  const dismiss = useCallback(id => {
    setToasts(current => current.filter(toast => toast.id !== id));
  }, []);

  return (
    <>
      <MainView notify={notify} />
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
