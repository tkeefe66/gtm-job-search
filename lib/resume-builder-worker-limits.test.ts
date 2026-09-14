import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const spawn=vi.hoisted(()=>vi.fn());
vi.mock('node:child_process',()=>({spawn}));
vi.mock('./resume-builder-html',()=>({builderHtml:()=>'<html></html>'}));
import {renderBuilderPdf} from './resume-builder-render';
import type {BuilderProfile,BuilderDesign} from './resume-builder-model';
const profile:BuilderProfile={name:'Test',headline:'',summary:'',contact:'',sections:[],sourceText:''};
const design:BuilderDesign={template:'classic',font:'sans',accent:'slate',pageSize:'letter',pageLimit:1};
beforeEach(()=>{vi.useFakeTimers();spawn.mockReset();});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
it('timeout kills the detached browser group as well as the worker group',async()=>{
 // Mutation: killing only the worker leaves Playwright detached Chromium running after timeout.
 const child=Object.assign(new EventEmitter(),{pid:9876,stdin:Object.assign(new EventEmitter(),{end:vi.fn()}),stdout:new EventEmitter(),stderr:{resume:vi.fn()},kill:vi.fn()});
 spawn.mockReturnValue(child);const kill=vi.spyOn(process,'kill').mockReturnValue(true);
 const outcome=renderBuilderPdf(profile,design).catch(error=>error);
 await vi.advanceTimersByTimeAsync(1);child.emit('message',{browserPid:9877});await vi.advanceTimersByTimeAsync(25000);
 expect((await outcome).message).toMatch(/timed out/);expect(kill).toHaveBeenCalledWith(-9877,'SIGKILL');expect(kill).toHaveBeenCalledWith(-9876,'SIGKILL');
 expect(spawn.mock.calls[0][2].env).not.toHaveProperty('DATABASE_URL');
});
