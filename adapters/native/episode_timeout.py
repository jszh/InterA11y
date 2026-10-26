import argparse

def parse_episode_timeout(value):
    seconds = int(value)
    if seconds < 0:
        raise argparse.ArgumentTypeError('Episode timeout must be nonnegative; 0 disables it')
    return seconds or None

def episode_deadline(started, timeout):
    return started + timeout if timeout is not None else float('inf')
