# Frozen Boat guest capture from f3880268, before wire-envelope admission.
# Compatibility consumer for rolling upgrades, not the current implementation.
@locked
def capture_v1(harness,session,fresh,digest):
    if not isinstance(session,str) or not UUID.fullmatch(session): raise ValueError('unsafe')
    init()
    # Old pre-fingerprint draft state cannot be disambiguated safely; a fresh
    # physical generation clears it. New admissions never write this global flag.
    if os.path.exists(ROOT+'/disabled.json'): return None
    try: pending=load('pending.json')
    except FileNotFoundError: return None
    ticket=pending['ticket']
    if not isinstance(ticket,str) or not ID.fullmatch(ticket): raise ValueError('unsafe')
    if time.time()-pending['at']>90:
        retire_pending(pending,'admission_expired');return None
    if not isinstance(digest,str) or pending.get('digest')!=digest:
        entry=load(ticket+'.json');entry['collectionReason']='native_input_unmatched';save(ticket+'.json',entry)
        return None
    if os.path.exists(ROOT+'/blocked-'+digest+'.json') or load(ticket+'.json').get('session'): return None
    previous='session-'+session+'.json'
    try:
        prior_ticket=load(previous)['ticket'];prior=load(prior_ticket+'.json')
        if not prior.get('terminal'):
            prior['invalid']=True;prior['collectionReason']='native_boundary_unverified';save(prior_ticket+'.json',prior)
            entry=load(ticket+'.json');entry['invalid']=True;entry['collectionReason']='native_boundary_unverified';save(ticket+'.json',entry)
    except FileNotFoundError: pass
    entry=load(ticket+'.json');entry.update(harness=harness,session=session,fresh=fresh)
    save(ticket+'.json',entry);save(previous,{'ticket':ticket});os.unlink(ROOT+'/pending.json')
    return ticket

