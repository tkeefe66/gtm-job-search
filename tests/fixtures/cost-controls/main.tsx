import React from 'react';
import {createRoot} from 'react-dom/client';
import Watchlist from '../../../components/Watchlist';
import SpendLimitsPanel from '../../../components/SpendLimitsPanel';
import '../../../app/globals.css';
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:1050,margin:'32px auto',padding:'0 20px'}}><Watchlist/><SpendLimitsPanel isAdmin={!location.search.includes('member')} provider="anthropic"/></main>);
