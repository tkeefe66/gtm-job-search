"use client";
import { useEffect, useRef, useState } from 'react';
/** Scale the iframe viewport, rather than changing the document's print geometry. */
export default function ResumePreview({ html, pageSize }: {
    html: string;
    pageSize: 'letter' | 'a4';
}) {
    const host = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(600);
    const [height, setHeight] = useState(700);
    const paperWidth = pageSize === 'letter' ? 816 : 794;
    const scale = Math.min(1, width / paperWidth);
    useEffect(() => {
        const element = host.current;
        if (!element)
            return;
        const observer = new ResizeObserver(entries => { setWidth(entries[0].contentRect.width); setHeight(entries[0].contentRect.height); });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    return <div ref={host} className="rb-preview-frame"><iframe title="Resume layout preview" sandbox="allow-scripts" srcDoc={html} style={{ width: paperWidth, height: height / scale, transform: `scale(${scale})`, transformOrigin: 'top left' }}/></div>;
}
